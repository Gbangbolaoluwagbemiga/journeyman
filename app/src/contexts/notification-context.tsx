
import { encodeJobId } from "@/lib/id-codec";
import {
  createContext,
  use,
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import { useWeb3 } from "./web3-context";
import { useMyAddress } from "@/hooks/use-my-address";
import { useToast } from "@/hooks/use-toast";
import {
  getInbox,
  getNotifications,
  isApiConfigured,
  patchNotificationRead,
  postNotification,
  notificationIdIsRemote,
  type RemoteNotificationRow,
} from "@/lib/api";

function mergeRemoteNotifications(
  remote: RemoteNotificationRow[],
  localState: Notification[],
): Notification[] {
  const fromRemote: Notification[] = remote.map((r) => ({
    id: r.id,
    type: r.type,
    title: r.title,
    message: r.message,
    read: r.read,
    timestamp: new Date(r.timestamp),
    actionUrl: r.actionUrl,
    data: r.data as Record<string, unknown> | undefined,
  }));
  
  // Keep all local notifications (both legacy and recent)
  const byId = new Map<string, Notification>();
  
  // Add remote notifications first
  for (const n of fromRemote) byId.set(n.id, n);
  
  // Add local notifications (won't overwrite remote ones with same ID)
  for (const n of localState) {
    if (!byId.has(n.id)) byId.set(n.id, n);
  }
  
  return Array.from(byId.values()).sort(
    (a, b) => b.timestamp.getTime() - a.timestamp.getTime(),
  );
}

export interface Notification {
  id: string;
  type:
    | "milestone"
    | "dispute"
    | "escrow"
    | "application"
    | "message"
    | "rating";
  title: string;
  message: string;
  timestamp: Date;
  read: boolean;
  actionUrl?: string;
  data?: Record<string, any>;
}

interface NotificationContextType {
  notifications: Notification[];
  unreadCount: number;
  addNotification: (
    notification: Omit<Notification, "id" | "timestamp" | "read">,
    targetAddresses?: string[],
  ) => void;
  markAsRead: (id: string) => void;
  markAllAsRead: () => void;
  clearNotifications: () => void;
  removeNotification: (id: string) => void;
  addCrossWalletNotification: (
    notification: Omit<Notification, "id" | "timestamp" | "read">,
    clientAddress?: string,
    freelancerAddress?: string,
  ) => void;
}

const NotificationContext = createContext<NotificationContextType | undefined>(
  undefined,
);

export function NotificationProvider({ children }: { children: ReactNode }) {
  const { wallet } = useWeb3();

  /*
   * WHO THIS BELL BELONGS TO.
   *
   * Everything here keyed off a CONNECTED wallet, so a managed worker — who
   * signs in with Google and never connects one — had a permanently empty bell.
   * They are exactly the people who need it: a freelancer is not sitting on a
   * dashboard waiting to learn their work came back. The notifications were
   * written, stored and addressed to them; nothing could read them back because
   * nothing knew who they were.
   *
   * A connected wallet still wins — that is the person actively using the app
   * as a client.
   */
  const identity = useMyAddress();
  const hasIdentity = Boolean(identity);
  const { toast } = useToast();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const lastRemoteFingerprintRef = useRef<string>("");
  const lastRemoteIdsRef = useRef<Set<string>>(new Set());
  const lastSyncTimeRef = useRef<number>(0);
  const syncInProgressRef = useRef<boolean>(false);

  const isCrossPartyRemoteNotification = useCallback(
    (row: RemoteNotificationRow): boolean => {
      const current = identity?.toLowerCase();
      if (!current) return false;

      const source =
        (row.data?.sourceAddress as string | undefined) ||
        (row.data?.actorAddress as string | undefined) ||
        (row.data?.fromAddress as string | undefined);

      if (source && source.toLowerCase() === current) return false;

      // These types indicate escrow lifecycle changes relevant to opposite party updates.
      return (
        row.type === "milestone" ||
        row.type === "application" ||
        row.type === "escrow" ||
        row.type === "dispute"
      );
    },
    [identity],
  );

  // Load notifications from localStorage on mount and when wallet changes
  useEffect(() => {
    if (hasIdentity) {
      const saved = localStorage.getItem(`notifications_${identity}`);
      if (saved) {
        try {
          const parsedNotifications = JSON.parse(saved);
          // Convert timestamp strings back to Date objects
          const notificationsWithDates = parsedNotifications.map(
            (notif: any) => ({
              ...notif,
              timestamp: new Date(notif.timestamp),
            }),
          );
          setNotifications(notificationsWithDates);
        } catch (error) {
          setNotifications([]);
        }
      } else {
        // If no saved notifications, start with empty array
        setNotifications([]);
      }
    } else {
      // If wallet not connected, clear notifications
      setNotifications([]);
    }
  }, [hasIdentity, identity]);

  // Persist ALL notifications to localStorage (both local and remote)
  useEffect(() => {
    if (hasIdentity && notifications.length > 0) {
      localStorage.setItem(
        `notifications_${identity}`,
        JSON.stringify(notifications),
      );
    }
  }, [notifications, hasIdentity, identity]);

  const syncRemoteNotifications = useCallback(async () => {
    if (!identity || !isApiConfigured()) return;
    
    // Prevent concurrent syncs and rate limit to once per 5 seconds minimum
    if (syncInProgressRef.current) return;
    const now = Date.now();
    if (now - lastSyncTimeRef.current < 5000) return;
    
    syncInProgressRef.current = true;
    lastSyncTimeRef.current = now;
    
    try {
      const remote = await getNotifications(identity);
      const prevIds = lastRemoteIdsRef.current;
      const nextIds = new Set(remote.map((r) => r.id));
      const newRows = remote.filter((r) => !prevIds.has(r.id));
      lastRemoteIdsRef.current = nextIds;

      const fingerprint = remote
        .slice(0, 8)
        .map((r) => `${r.id}:${r.read ? "1" : "0"}`)
        .join("|");
      lastRemoteFingerprintRef.current = fingerprint;
      setNotifications((prev) => mergeRemoteNotifications(remote, prev));

      // Refresh dashboard/freelancer pages on any cross-party row we haven't
      // already seen this session. Crucially, we DO fire on the first sync
      // after mount too — that's the case where the user opens the app after
      // the counterparty already acted, and the dashboard is otherwise stuck
      // on stale-on-mount data.
      const crossPartyNewRows = newRows.filter((row) => isCrossPartyRemoteNotification(row));
      if (crossPartyNewRows.length > 0) {
        const sourceAddress =
          (crossPartyNewRows[0]?.data?.sourceAddress as string | undefined) ??
          (crossPartyNewRows[0]?.data?.actorAddress as string | undefined);
        window.dispatchEvent(
          new CustomEvent("escrowUpdated", { detail: { sourceAddress } }),
        );
      }
    } catch {
      /* offline or API down — keep local state */
    } finally {
      syncInProgressRef.current = false;
    }
  }, [wallet.address, isCrossPartyRemoteNotification]);

  const addNotification = (
    notification: Omit<Notification, "id" | "timestamp" | "read">,
    targetAddresses?: string[], // Optional: specific addresses to notify
  ) => {
    const newNotification: Notification = {
      ...notification,
      id: `notification_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date(),
      read: false,
    };

    // Keep original addresses for API calls; use lowercase only for comparisons
    const targets = (targetAddresses ?? []).filter(Boolean);
    const current = wallet.address?.toLowerCase();
    const shouldNotifyCurrent =
      targets.length === 0 ||
      (current ? targets.some((a) => a && a.toLowerCase() === current) : false);

    if (shouldNotifyCurrent) {
      setNotifications((prev) => [newNotification, ...prev]);
    }

    // Send cross-wallet notifications via backend API (Supabase) so the
    // other party actually receives them regardless of browser / device.
    if (targets.length > 0) {
      targets.forEach((address) => {
        if (address && address.toLowerCase() !== current) {
          if (isApiConfigured()) {
            const outboundData = {
              ...(notification.data ?? {}),
              sourceAddress: wallet.address,
            };
            postNotification({
              wallet_address: address, // Use original case address
              type: notification.type,
              title: notification.title,
              message: notification.message,
              action_url: notification.actionUrl,
              data: outboundData,
            }).catch(() => {
              // Fallback: write to localStorage so the other party at least
              // sees it if they happen to share the same browser profile.
              try {
                const existing = JSON.parse(
                  localStorage.getItem(`notifications_${address}`) || "[]",
                );
                localStorage.setItem(
                  `notifications_${address}`,
                  JSON.stringify([newNotification, ...existing]),
                );
              } catch {
                // Silently fail if localStorage is unavailable
              }
            });
          } else {
            try {
              const existing = JSON.parse(
                localStorage.getItem(`notifications_${address}`) || "[]",
              );
              localStorage.setItem(
                `notifications_${address}`,
                JSON.stringify([newNotification, ...existing]),
              );
            } catch {
              // Silently fail if localStorage is unavailable
            }
          }
        }
      });
    }

    if (
      shouldNotifyCurrent &&
      (notification.type === "milestone" || notification.type === "dispute")
    ) {
      toast({
        title: notification.title,
        description: notification.message,
      });
    }
  };

  /*
   * A DIRECT MESSAGE RINGS THE BELL.
   *
   * It did not. Messages had a table, routes, an inbox page and a
   * `getUnreadMessageCount` helper that nothing in the app ever called — so a
   * client could send a freelancer a message and the only way to find out was
   * to go looking for a page that was not in the nav. Somebody was messaged and
   * never knew.
   *
   * One notification per thread, not per message: the point is "this person is
   * waiting on you", and three pings for three lines of one conversation is
   * noise. The id is derived from the thread and the time of its newest
   * message, so polling re-derives the same id and merges rather than piling
   * up, and a genuinely newer message makes a new one.
   */
  useEffect(() => {
    if (!identity || !isApiConfigured()) return;
    let cancelled = false;

    const check = async () => {
      let inbox: Awaited<ReturnType<typeof getInbox>>;
      try {
        inbox = await getInbox(identity);
      } catch {
        /* The bell is a courtesy; a failed read leaves it as it was rather than
           clearing notifications the user has not seen yet. */
        return;
      }
      if (cancelled) return;

      const fresh: Notification[] = inbox
        .filter((c) => c.unread > 0)
        .map((c) => ({
          id: `message_${c.conversation_id}_${c.latest_at}`,
          type: "message" as const,
          title: c.unread > 1 ? `${c.unread} new messages` : "New message",
          message: `${c.other_address.slice(0, 6)}…${c.other_address.slice(-4)}: ${c.latest_message.slice(0, 120)}`,
          timestamp: new Date(c.latest_at),
          read: false,
          actionUrl: "/messages",
          data: { conversationId: c.conversation_id, from: c.other_address },
        }));

      if (fresh.length === 0) return;

      setNotifications((prev) => {
        const known = new Set(prev.map((n) => n.id));
        const added = fresh.filter((n) => !known.has(n.id));
        if (added.length === 0) return prev;
        return [...added, ...prev].sort(
          (a, b) => b.timestamp.getTime() - a.timestamp.getTime(),
        );
      });
    };

    void check();
    const t = window.setInterval(() => void check(), 20_000);
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.clearInterval(t);
      window.removeEventListener("focus", onFocus);
    };
  }, [identity]);

  useEffect(() => {
    if (!identity || !isApiConfigured()) return;
    lastRemoteFingerprintRef.current = "";
    lastRemoteIdsRef.current = new Set();
    void syncRemoteNotifications();
    // Poll every 10s — tight enough to feel "live" without hammering the API.
    // The internal rate-limiter still enforces a 5s floor between actual syncs.
    const t = window.setInterval(() => void syncRemoteNotifications(), 10_000);

    // Refresh aggressively when the tab regains focus / visibility.
    const handleFocus = () => void syncRemoteNotifications();
    const handleVisibility = () => {
      if (document.visibilityState === "visible") void syncRemoteNotifications();
    };
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibility);
    
    // Listen for work started events
    const handleWorkStarted = (event: CustomEvent) => {
      const { 
        escrowId, 
        freelancerAddress, 
        clientAddress, 
        projectTitle, 
        freelancerName 
      } = event.detail;
      
      // Notify the client that work has started
      if (clientAddress) {
        addNotification(
          {
            type: "escrow",
            title: "Work Started!",
            message: `${freelancerName} has started work on ${projectTitle}`,
            actionUrl: `/dashboard?escrow=${escrowId}`,
            data: {
              escrowId,
              freelancerName,
              projectTitle,
              freelancerAddress,
            },
          },
          [clientAddress]
        );
      }
      
      // Notify the freelancer (confirmation)
      if (freelancerAddress) {
        addNotification(
          {
            type: "escrow",
            title: "Work Started!",
            message: `You have successfully started work on "${projectTitle}"`,
            actionUrl: `/freelancer?escrow=${escrowId}`,
            data: {
              escrowId,
              action: "work_started_confirmation",
            },
          },
          [freelancerAddress]
        );
      }
    };
    
    // Listen for job application events
    const handleJobApplicationSubmitted = (event: CustomEvent) => {
      const {
        jobId,
        freelancerAddress,
        clientAddress,
        jobTitle,
        freelancerName,
      } = event.detail;
      
      // Notify the client about the new application
      if (clientAddress) {
        addNotification(
          {
            type: "application",
            title: "New Job Application",
            message: `Someone applied to your job: ${jobTitle}`,
            actionUrl: `/approvals?job=${jobId}`,
            data: {
              jobId,
              freelancerAddress,
              jobTitle,
              freelancerName,
            },
          },
          [clientAddress]
        );
      }
      
      // Notify the freelancer (confirmation)
      if (freelancerAddress) {
        addNotification(
          {
            type: "application",
            title: "Application Submitted!",
            message: `Your application for "${jobTitle}" has been submitted successfully`,
            actionUrl: `/browse-jobs?job=${jobId}`,
            data: {
              jobId,
              action: "application_submitted_confirmation",
            },
          },
          [freelancerAddress]
        );
      }
    };

    // Listen for milestone proposal events
    const handleMilestoneProposalSubmitted = (event: CustomEvent) => {
      const {
        escrowId,
        milestoneIndex,
        freelancerAddress,
        proposedAmount,
        proposedDescription,
      } = event.detail;

      // Get escrow details to find client address
      (async () => {
        try {
          const { ContractService } = await import("@/lib/web3/contract-service");
          const cs = new ContractService();
          const escrow = await cs.getEscrow(Number(escrowId));
          
          if (escrow && escrow.depositor) {
            // Notify the client about the proposal
            addNotification(
              {
                type: "milestone",
                title: "Milestone Proposal Received",
                message: `Freelancer proposed changes to milestone ${milestoneIndex + 1}. New amount: ${(parseFloat(proposedAmount) / 1e18).toFixed(6)} USDC`,
                actionUrl: `/dashboard?escrow=${escrowId}`,
                data: {
                  escrowId,
                  milestoneIndex,
                  freelancerAddress,
                  proposedAmount,
                  proposedDescription,
                  action: "milestone_proposal_pending",
                },
              },
              [escrow.depositor]
            );
          }
        } catch (error) {
          // Silently fail - notification is not critical
        }
      })();
    };

    // Listen for milestone proposal rejection events
    const handleMilestoneProposalRejected = (event: CustomEvent) => {
      const {
        escrowId,
        milestoneIndex,
        freelancerAddress,
      } = event.detail;

      // Lock the freelancer's one-shot proposal slot for this escrow — they don't
      // get another go after a rejection (decided in product spec).
      if (freelancerAddress) {
        try {
          localStorage.setItem(
            `proposal_used_${escrowId}_${freelancerAddress.toLowerCase()}`,
            "1",
          );
        } catch { /* ignore */ }
      }

      if (freelancerAddress) {
        addNotification(
          {
            type: "milestone",
            title: "Proposal Rejected",
            message: `Your proposal for milestone ${milestoneIndex + 1} was rejected. The original terms remain in effect.`,
            actionUrl: `/freelancer?escrow=${escrowId}`,
            data: {
              escrowId,
              milestoneIndex,
              action: "milestone_proposal_rejected",
            },
          },
          [freelancerAddress]
        );
      }
    };

    // Listen for milestone proposal approval events
    const handleMilestoneProposalApproved = (event: CustomEvent) => {
      const {
        escrowId,
        milestoneIndex,
        freelancerAddress,
        proposedAmount,
      } = event.detail;

      // Notify the freelancer that their proposal was approved
      if (freelancerAddress) {
        addNotification(
          {
            type: "milestone",
            title: "Proposal Approved!",
            message: `Your proposal for milestone ${milestoneIndex + 1} was approved. New amount: ${(parseFloat(proposedAmount) / 1e18).toFixed(6)} USDC. You can now submit the milestone.`,
            actionUrl: `/freelancer?escrow=${escrowId}`,
            data: {
              escrowId,
              milestoneIndex,
              proposedAmount,
              action: "milestone_proposal_approved",
            },
          },
          [freelancerAddress]
        );
      }
    };
    
    const handleFreelancerAccepted = (event: Event) => {
      const customEvent = event as CustomEvent;
      const { escrowId, projectTitle, clientAddress, freelancerAddress } = customEvent.detail || {};
      
      if (freelancerAddress && freelancerAddress.toLowerCase() === wallet.address?.toLowerCase()) {
        // Show notification immediately to the freelancer (they are the current user)
        const notification = createFreelancerAcceptanceNotification(escrowId, {
          projectTitle,
          clientAddress,
        });
        
        // Add to current user's notifications immediately
        setNotifications((prev) => [
          {
            ...notification,
            id: `notification_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            timestamp: new Date(),
            read: false,
          },
          ...prev,
        ]);
        
        // Also show a toast for immediate feedback
        toast({
          title: notification.title,
          description: notification.message,
        });
        
        // Send to backend for persistence
        if (isApiConfigured()) {
          postNotification({
            wallet_address: freelancerAddress,
            type: notification.type,
            title: notification.title,
            message: notification.message,
            action_url: notification.actionUrl,
            data: {
              ...(notification.data ?? {}),
              sourceAddress: clientAddress,
            },
          }).catch(() => {
            // Fallback to localStorage if API fails
            try {
              const existing = JSON.parse(
                localStorage.getItem(`notifications_${freelancerAddress}`) || "[]",
              );
              localStorage.setItem(
                `notifications_${freelancerAddress}`,
                JSON.stringify([
                  {
                    ...notification,
                    id: `notification_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                    timestamp: new Date(),
                    read: false,
                  },
                  ...existing,
                ]),
              );
            } catch {
              // Silently fail
            }
          });
        }
      }
    };

    const handleDisputeRaised = (event: Event) => {
      const customEvent = event as CustomEvent;
      const { escrowId, milestoneIndex, clientAddress, freelancerAddress } = customEvent.detail || {};
      
      // Notify both client and freelancer
      addCrossWalletNotification(
        createDisputeNotification("raised", escrowId, milestoneIndex, {
          clientAddress,
          freelancerAddress,
        }),
        clientAddress,
        freelancerAddress
      );
    };

    const handleDisputeResolved = (event: Event) => {
      const customEvent = event as CustomEvent;
      const { escrowId, milestoneIndex, clientAddress, freelancerAddress, freelancerAmount, clientAmount, reason } = customEvent.detail || {};
      
      if (escrowId && milestoneIndex !== undefined) {
        if (reason) {
          localStorage.setItem(`resolution_${escrowId}_${milestoneIndex}`, reason);
        }
        if (freelancerAmount) {
          localStorage.setItem(`resolution_fa_${escrowId}_${milestoneIndex}`, freelancerAmount.toString());
        }
        if (clientAmount) {
          localStorage.setItem(`resolution_ca_${escrowId}_${milestoneIndex}`, clientAmount.toString());
        }
      }
      
      // Notify both client and freelancer with resolution details
      addCrossWalletNotification(
        createDisputeNotification("resolved", escrowId, milestoneIndex, {
          clientAddress,
          freelancerAddress,
          freelancerAmount,
          clientAmount,
          resolutionDetails: `Freelancer: ${freelancerAmount}, Client: ${clientAmount}`,
          reason,
        }),
        clientAddress,
        freelancerAddress
      );
    };
    
    // Listen for milestone submission events
    const handleMilestoneSubmitted = (event: CustomEvent) => {
      const {
        escrowId,
        milestoneIndex,
        sourceAddress,
      } = event.detail || {};
      
      // Get escrow details to find client address and send notification
      (async () => {
        try {
          const { ContractService } = await import("@/lib/web3/contract-service");
          const cs = new ContractService();
          const escrow = await cs.getEscrow(Number(escrowId));
          
          if (escrow && escrow.depositor && sourceAddress) {
            // Only notify if the source is not the current user
            const currentAddress = wallet.address?.toLowerCase();
            const sourceAddr = sourceAddress.toLowerCase();
            
            if (currentAddress !== sourceAddr) {
              // Notify the client about milestone submission
              addNotification(
                {
                  type: "milestone",
                  title: "New Milestone Submitted",
                  message: `Milestone ${milestoneIndex + 1} has been submitted for review`,
                  actionUrl: `/dashboard?escrow=${escrowId}`,
                  data: {
                    escrowId,
                    milestoneIndex,
                    action: "milestone_submitted",
                    sourceAddress,
                  },
                },
                [escrow.depositor]
              );
            }
          }
        } catch (error) {
          // Silently fail - notification is not critical
          console.error('Failed to send milestone submission notification:', error);
        }
      })();
    };
    
    // Listen for milestone approval events
    const handleMilestoneApproved = (event: CustomEvent) => {
      const {
        escrowId,
        milestoneIndex,
        sourceAddress,
      } = event.detail || {};
      
      // Get escrow details to find freelancer address and send notification
      (async () => {
        try {
          const { ContractService } = await import("@/lib/web3/contract-service");
          const cs = new ContractService();
          const escrow = await cs.getEscrow(Number(escrowId));
          
          if (escrow && escrow.beneficiary && sourceAddress) {
            // Only notify if the source is not the current user
            const currentAddress = wallet.address?.toLowerCase();
            const sourceAddr = sourceAddress.toLowerCase();
            
            if (currentAddress !== sourceAddr) {
              // Notify the freelancer about milestone approval
              addNotification(
                {
                  type: "milestone",
                  title: "Milestone Approved! 🎉",
                  message: `Milestone ${milestoneIndex + 1} has been approved. Payment released!`,
                  actionUrl: `/freelancer?escrow=${escrowId}`,
                  data: {
                    escrowId,
                    milestoneIndex,
                    action: "milestone_approved",
                    sourceAddress,
                  },
                },
                [escrow.beneficiary]
              );
            }
          }
        } catch (error) {
          console.error('Failed to send milestone approval notification:', error);
        }
      })();
    };
    
    // Listen for milestone rejection events
    const handleMilestoneRejected = (event: CustomEvent) => {
      const {
        escrowId,
        milestoneIndex,
        sourceAddress,
        reason,
      } = event.detail || {};
      
      // Get escrow details to find freelancer address and send notification
      (async () => {
        try {
          const { ContractService } = await import("@/lib/web3/contract-service");
          const cs = new ContractService();
          const escrow = await cs.getEscrow(Number(escrowId));
          
          if (escrow && escrow.beneficiary && sourceAddress) {
            // Only notify if the source is not the current user
            const currentAddress = wallet.address?.toLowerCase();
            const sourceAddr = sourceAddress.toLowerCase();
            
            if (currentAddress !== sourceAddr) {
              // Notify the freelancer about milestone rejection
              addNotification(
                {
                  type: "milestone",
                  title: "Milestone Rejected",
                  message: `Milestone ${milestoneIndex + 1} was rejected. ${reason ? `Reason: ${reason}` : 'Please review and resubmit.'}`,
                  actionUrl: `/freelancer?escrow=${escrowId}`,
                  data: {
                    escrowId,
                    milestoneIndex,
                    action: "milestone_rejected",
                    reason,
                    sourceAddress,
                  },
                },
                [escrow.beneficiary]
              );
            }
          }
        } catch (error) {
          console.error('Failed to send milestone rejection notification:', error);
        }
      })();
    };
    
    window.addEventListener("workStarted", handleWorkStarted as EventListener);
    window.addEventListener("jobApplicationSubmitted", handleJobApplicationSubmitted as EventListener);
    window.addEventListener("milestoneSubmitted", handleMilestoneSubmitted as EventListener);
    window.addEventListener("milestoneApproved", handleMilestoneApproved as EventListener);
    window.addEventListener("milestoneRejected", handleMilestoneRejected as EventListener);
    window.addEventListener("milestoneProposalSubmitted", handleMilestoneProposalSubmitted as EventListener);
    window.addEventListener("milestoneProposalRejected", handleMilestoneProposalRejected as EventListener);
    window.addEventListener("milestoneProposalApproved", handleMilestoneProposalApproved as EventListener);
    window.addEventListener("freelancerAccepted", handleFreelancerAccepted as EventListener);
    window.addEventListener("disputeRaised", handleDisputeRaised as EventListener);
    window.addEventListener("disputeResolved", handleDisputeResolved as EventListener);
    
    return () => {
      window.clearInterval(t);
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("workStarted", handleWorkStarted as EventListener);
      window.removeEventListener("jobApplicationSubmitted", handleJobApplicationSubmitted as EventListener);
      window.removeEventListener("milestoneSubmitted", handleMilestoneSubmitted as EventListener);
      window.removeEventListener("milestoneApproved", handleMilestoneApproved as EventListener);
      window.removeEventListener("milestoneRejected", handleMilestoneRejected as EventListener);
      window.removeEventListener("milestoneProposalSubmitted", handleMilestoneProposalSubmitted as EventListener);
      window.removeEventListener("milestoneProposalRejected", handleMilestoneProposalRejected as EventListener);
      window.removeEventListener("milestoneProposalApproved", handleMilestoneProposalApproved as EventListener);
      window.removeEventListener("freelancerAccepted", handleFreelancerAccepted as EventListener);
      window.removeEventListener("disputeRaised", handleDisputeRaised as EventListener);
      window.removeEventListener("disputeResolved", handleDisputeResolved as EventListener);
    };
    // addNotification intentionally omitted from deps — it's recreated every
    // render which would re-tear listeners and reset lastRemoteIdsRef on every
    // state update, causing an infinite refresh loop. Its closure only depends
    // on wallet.address, which IS in deps, so the captured fn stays correct.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet.address, syncRemoteNotifications]);

  const markAsRead = (id: string) => {
    if (wallet.address && notificationIdIsRemote(id)) {
      void patchNotificationRead(wallet.address, id).catch(() => {});
    }
    setNotifications((prev) =>
      prev.map((notification) =>
        notification.id === id ? { ...notification, read: true } : notification,
      ),
    );
  };

  const markAllAsRead = () => {
    setNotifications((prev) => {
      if (wallet.address && isApiConfigured()) {
        for (const n of prev) {
          if (!n.read && notificationIdIsRemote(n.id)) {
            void patchNotificationRead(wallet.address, n.id).catch(() => {});
          }
        }
      }
      return prev.map((notification) => ({ ...notification, read: true }));
    });
  };

  const clearNotifications = () => {
    setNotifications([]);
  };

  const removeNotification = (id: string) => {
    setNotifications((prev) =>
      prev.filter((notification) => notification.id !== id),
    );
  };

  const addCrossWalletNotification = (
    notification: Omit<Notification, "id" | "timestamp" | "read">,
    clientAddress?: string,
    freelancerAddress?: string,
  ) => {
    const newNotification: Notification = {
      ...notification,
      id: `notification_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date(),
      read: false,
    };

    const current = wallet.address?.toLowerCase();

    // Collect all target addresses (both client and freelancer)
    const targetAddresses = [];
    if (
      clientAddress &&
      clientAddress.toLowerCase() !== wallet.address?.toLowerCase()
    ) {
      targetAddresses.push(clientAddress.toLowerCase());
    }
    if (
      freelancerAddress &&
      freelancerAddress.toLowerCase() !== wallet.address?.toLowerCase()
    ) {
      targetAddresses.push(freelancerAddress.toLowerCase());
    }

    // Only add to current wallet if it was explicitly provided as a target.
    if (
      current &&
      ((clientAddress && clientAddress.toLowerCase() === current) ||
        (freelancerAddress && freelancerAddress.toLowerCase() === current))
    ) {
      setNotifications((prev) => [newNotification, ...prev]);
    }

    // Send cross-wallet notifications via backend API (Supabase).
    targetAddresses.forEach((address) => {
      if (isApiConfigured()) {
        const outboundData = {
          ...(newNotification.data ?? {}),
          sourceAddress: wallet.address,
        };
        postNotification({
          wallet_address: address,
          type: newNotification.type,
          title: newNotification.title,
          message: newNotification.message,
          action_url: newNotification.actionUrl,
          data: outboundData,
        }).catch(() => {
          try {
            const existing = JSON.parse(
              localStorage.getItem(`notifications_${address}`) || "[]",
            );
            localStorage.setItem(
              `notifications_${address}`,
              JSON.stringify([newNotification, ...existing]),
            );
          } catch {
            // Silently fail if localStorage is unavailable
          }
        });
      } else {
        try {
          const existing = JSON.parse(
            localStorage.getItem(`notifications_${address}`) || "[]",
          );
          localStorage.setItem(
            `notifications_${address}`,
            JSON.stringify([newNotification, ...existing]),
          );
        } catch {
          // Silently fail if localStorage is unavailable
        }
      }
    });

    // Show toast for important notifications
    if (
      current &&
      ((clientAddress && clientAddress.toLowerCase() === current) ||
        (freelancerAddress && freelancerAddress.toLowerCase() === current)) &&
      (notification.type === "milestone" || notification.type === "dispute")
    ) {
      toast({
        title: notification.title,
        description: notification.message,
      });
    }
  };

  const unreadCount = notifications.filter((n) => !n.read).length;

  return (
    <NotificationContext
      value={{
        notifications,
        unreadCount,
        addNotification,
        markAsRead,
        markAllAsRead,
        clearNotifications,
        removeNotification,
        addCrossWalletNotification,
      }}
    >
      {children}
    </NotificationContext>
  );
}

export function useNotifications() {
  const context = use(NotificationContext);
  if (context === undefined) {
    throw new Error(
      "useNotifications must be used within a NotificationProvider",
    );
  }
  return context;
}

// Helper functions for common notification types
export const createMilestoneNotification = (
  action: "submitted" | "approved" | "rejected" | "disputed",
  escrowId: string,
  milestoneIndex: number,
  additionalData?: Record<string, any>,
): Omit<Notification, "id" | "timestamp" | "read"> => {
  const baseData = {
    escrowId,
    milestoneIndex,
    ...additionalData,
  };

  switch (action) {
    case "submitted":
      return {
        type: "milestone",
        title: "New Milestone Submitted",
        message: `Milestone ${milestoneIndex + 1} has been submitted for review`,
        actionUrl: `/dashboard?escrow=${escrowId}`,
        data: baseData,
      };
    case "approved":
      return {
        type: "milestone",
        title: "Milestone Approved!",
        message: `Milestone ${milestoneIndex + 1} has been approved and payment released`,
        actionUrl: `/freelancer?escrow=${escrowId}`,
        data: baseData,
      };
    case "rejected":
      return {
        type: "milestone",
        title: "Milestone Rejected",
        message: `Milestone ${milestoneIndex + 1} has been rejected. Please review and resubmit`,
        actionUrl: `/freelancer?escrow=${escrowId}`,
        data: baseData,
      };
    case "disputed":
      return {
        type: "dispute",
        title: "Milestone Disputed",
        message: `Milestone ${milestoneIndex + 1} is under dispute and requires admin review`,
        actionUrl: `/admin?escrow=${escrowId}`,
        data: baseData,
      };
    default:
      return {
        type: "milestone",
        title: "Milestone Update",
        message: `Milestone ${milestoneIndex + 1} status updated`,
        actionUrl: `/dashboard?escrow=${escrowId}`,
        data: baseData,
      };
  }
};

export const createEscrowNotification = (
  action: "created" | "completed" | "refunded" | "work_started",
  escrowId: string,
  additionalData?: Record<string, any>,
): Omit<Notification, "id" | "timestamp" | "read"> => {
  const baseData = {
    escrowId,
    ...additionalData,
  };

  switch (action) {
    case "created":
      return {
        type: "escrow",
        title: "New Escrow Created",
        message: "A new escrow has been created and is ready for work",
        actionUrl: `/dashboard?escrow=${escrowId}`,
        data: baseData,
      };
    case "completed":
      return {
        type: "escrow",
        title: "Escrow Completed!",
        message: "All milestones have been completed and payments released",
        actionUrl: `/dashboard?escrow=${escrowId}`,
        data: baseData,
      };
    case "refunded":
      return {
        type: "escrow",
        title: "Escrow Refunded",
        message: "The escrow has been refunded due to project cancellation",
        actionUrl: `/dashboard?escrow=${escrowId}`,
        data: baseData,
      };
    case "work_started":
      return {
        type: "escrow",
        title: "Work Started!",
        message: `${additionalData?.freelancerName || "Freelancer"} has started work on ${additionalData?.projectTitle || `Project #${escrowId}`}`,
        actionUrl: `/dashboard?escrow=${escrowId}`,
        data: baseData,
      };
    default:
      return {
        type: "escrow",
        title: "Escrow Update",
        message: "Escrow status has been updated",
        actionUrl: `/dashboard?escrow=${escrowId}`,
        data: baseData,
      };
  }
};

export const createApplicationNotification = (
  action: "submitted" | "approved" | "rejected",
  jobId: number,
  freelancerAddress: string,
  additionalData?: Record<string, any>,
): Omit<Notification, "id" | "timestamp" | "read"> => {
  const baseData = {
    jobId,
    freelancerAddress,
    ...additionalData,
  };

  switch (action) {
    case "submitted":
      return {
        type: "application",
        title: "New Job Application",
        message: `Someone applied to your job: ${additionalData?.jobTitle || encodeJobId(jobId)}`,
        actionUrl: `/approvals?job=${jobId}`,
        data: baseData,
      };
    case "approved":
      return {
        type: "application",
        title: "Application Approved!",
        message: `Your application for ${additionalData?.jobTitle || encodeJobId(jobId)} has been approved`,
        actionUrl: `/freelancer?job=${jobId}`,
        data: baseData,
      };
    case "rejected":
      return {
        type: "application",
        title: "Application Rejected",
        message: `Your application for ${additionalData?.jobTitle || encodeJobId(jobId)} was not selected`,
        actionUrl: `/freelancer?job=${jobId}`,
        data: baseData,
      };
    default:
      return {
        type: "application",
        title: "Application Update",
        message: `Application status updated for ${additionalData?.jobTitle || encodeJobId(jobId)}`,
        actionUrl: `/approvals?job=${jobId}`,
        data: baseData,
      };
  }
};

export const createRatingNotification = (
  action: "received",
  escrowId: number,
  additionalData?: Record<string, any>,
): Omit<Notification, "id" | "timestamp" | "read"> => {
  switch (action) {
    case "received":
    default:
      return {
        type: "rating",
        title: "New Rating Received",
        message: `You received a ${additionalData?.rating ?? "new"} star rating${
          additionalData?.review ? " with a review" : ""
        }.`,
        actionUrl: `/dashboard?escrow=${escrowId}`,
        data: {
          escrowId,
          ...additionalData,
        },
      };
  }
};

export const createFreelancerAcceptanceNotification = (
  escrowId: string,
  additionalData?: Record<string, any>,
): Omit<Notification, "id" | "timestamp" | "read"> => {
  return {
    type: "application",
    title: "🎉 You've Been Accepted!",
    message: `Congratulations! You've been accepted for ${additionalData?.projectTitle || `Project #${escrowId}`}. Work is ready to start!`,
    actionUrl: `/freelancer?escrow=${escrowId}`,
    data: {
      escrowId,
      ...additionalData,
    },
  };
};

export const createDisputeNotification = (
  action: "raised" | "resolved",
  escrowId: string,
  milestoneIndex: number,
  additionalData?: Record<string, any>,
): Omit<Notification, "id" | "timestamp" | "read"> => {
  const baseData = {
    escrowId,
    milestoneIndex,
    ...additionalData,
  };

  switch (action) {
    case "raised":
      return {
        type: "dispute",
        title: "⚠️ Dispute Raised",
        message: `A dispute has been raised for Milestone ${milestoneIndex + 1}. Admin review is in progress.`,
        actionUrl: `/dashboard?escrow=${escrowId}`,
        data: baseData,
      };
    case "resolved":
      return {
        type: "dispute",
        title: "✅ Dispute Resolved",
        message: `The dispute for Milestone ${milestoneIndex + 1} has been resolved by admin. Check the details for the decision.`,
        actionUrl: `/dashboard?escrow=${escrowId}`,
        data: baseData,
      };
    default:
      return {
        type: "dispute",
        title: "Dispute Update",
        message: `Dispute status updated for Milestone ${milestoneIndex + 1}`,
        actionUrl: `/dashboard?escrow=${escrowId}`,
        data: baseData,
      };
  }
};
