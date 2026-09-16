import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Send, Loader2, MessageCircle, WifiOff } from "lucide-react";
import { sameAddress } from "@/hooks/use-my-address";
import {
  sendMessage,
  getConversation,
  markConversationRead,
  isApiConfigured,
  ChatMessage,
} from "@/lib/api";

interface ChatDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  myAddress: string;
  otherAddress: string;
  otherLabel?: string; // display name / short addr
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffDays = Math.floor(
    (now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24),
  );
  if (diffDays === 0) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  if (diffDays === 1) return "Yesterday";
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function avatarLetters(address: string): string {
  return address.slice(0, 2).toUpperCase();
}

const AVATAR_COLORS = [
  "bg-blue-500",
  "bg-purple-500",
  "bg-green-500",
  "bg-orange-500",
  "bg-rose-500",
  "bg-teal-500",
  "bg-indigo-500",
  "bg-amber-500",
];
function avatarColor(address: string): string {
  return AVATAR_COLORS[address.charCodeAt(1) % AVATAR_COLORS.length];
}

export function ChatDialog({
  open,
  onOpenChange,
  myAddress,
  otherAddress,
  otherLabel,
}: ChatDialogProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [apiOk] = useState(() => isApiConfigured());
  const bottomRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const latestTimestampRef = useRef<string | undefined>(undefined);

  const short = otherLabel ?? `${otherAddress.slice(0, 6)}…${otherAddress.slice(-4)}`;

  const fetchMessages = useCallback(
    async (since?: string) => {
      if (!apiOk || !myAddress || !otherAddress) return;
      try {
        const msgs = await getConversation(myAddress, otherAddress, since);
        if (msgs.length > 0) {
          setMessages((prev) => {
            const existing = new Set(prev.map((m) => m.id));
            const fresh = msgs.filter((m) => !existing.has(m.id));
            return fresh.length ? [...prev, ...fresh] : prev;
          });
          latestTimestampRef.current = msgs[msgs.length - 1].created_at;
        }
      } catch {
        /* silent poll failure */
      }
    },
    [apiOk, myAddress, otherAddress],
  );

  // Initial load + mark read when dialog opens
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setMessages([]);
    latestTimestampRef.current = undefined;
    fetchMessages()
      .then(() => {
        if (myAddress && otherAddress) {
          void markConversationRead(myAddress, otherAddress, myAddress).catch(
            () => {},
          );
        }
      })
      .finally(() => setLoading(false));
  }, [open, fetchMessages, myAddress, otherAddress]);

  // Poll for new messages every 15 seconds to reduce API load
  useEffect(() => {
    if (!open) return;
    pollRef.current = setInterval(() => {
      void fetchMessages(latestTimestampRef.current);
    }, 15000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [open, fetchMessages]);

  // Scroll to bottom when messages change
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = async () => {
    const trimmed = text.trim();
    if (!trimmed || sending || !myAddress) return;
    setSending(true);
    setText("");
    try {
      const result = await sendMessage({
        sender_address: myAddress,
        recipient_address: otherAddress,
        content: trimmed,
      });
      const optimistic: ChatMessage = {
        id: result.id,
        sender_address: myAddress,
        recipient_address: otherAddress,
        content: trimmed,
        read_at: null,
        created_at: result.created_at,
      };
      setMessages((prev) => [...prev, optimistic]);
      latestTimestampRef.current = result.created_at;
    } catch (err) {
      setText(trimmed); // restore on failure
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md p-0 flex flex-col gap-0 overflow-hidden max-h-[85vh]">
        {/* Header */}
        <DialogHeader className="px-5 py-4 border-b border-border/60 shrink-0">
          <div className="flex items-center gap-3">
            <div
              className={`w-9 h-9 rounded-full flex items-center justify-center text-white text-sm font-bold shrink-0 ${avatarColor(otherAddress)}`}
            >
              {avatarLetters(otherAddress)}
            </div>
            <div className="min-w-0">
              <DialogTitle className="text-sm font-semibold font-mono truncate">
                {short}
              </DialogTitle>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                Direct message
              </p>
            </div>
          </div>
        </DialogHeader>

        {/* Messages area */}
        <ScrollArea className="flex-1 px-4 py-3 min-h-0">
          {!apiOk ? (
            <div className="flex flex-col items-center gap-2 py-12 text-muted-foreground text-sm">
              <WifiOff className="h-8 w-8 opacity-30" />
              <p>Messaging requires the backend API to be configured.</p>
            </div>
          ) : loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
            </div>
          ) : messages.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-12 text-muted-foreground">
              <MessageCircle className="h-8 w-8 opacity-30" />
              <p className="text-sm">No messages yet. Say hello!</p>
            </div>
          ) : (
            <div className="space-y-2 pb-1">
              <AnimatePresence initial={false}>
                {messages.map((msg) => {
                  /* Case-insensitive: the backend folds addresses to one spelling, and a
                     client holding a checksummed address would otherwise see every
                     message they sent rendered as though somebody else had sent it. */
                  const isMine = sameAddress(msg.sender_address, myAddress);
                  return (
                    <motion.div
                      key={msg.id}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.15 }}
                      className={`flex ${isMine ? "justify-end" : "justify-start"}`}
                    >
                      <div
                        className={`max-w-[80%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed ${
                          isMine
                            ? "bg-primary text-primary-foreground rounded-br-sm"
                            : "bg-muted rounded-bl-sm"
                        }`}
                      >
                        <p className="whitespace-pre-wrap break-words">
                          {msg.content}
                        </p>
                        <p
                          className={`text-[10px] mt-1 text-right ${
                            isMine
                              ? "text-primary-foreground/60"
                              : "text-muted-foreground"
                          }`}
                        >
                          {formatTime(msg.created_at)}
                        </p>
                      </div>
                    </motion.div>
                  );
                })}
              </AnimatePresence>
              <div ref={bottomRef} />
            </div>
          )}
        </ScrollArea>

        {/* Input */}
        {apiOk && (
          <div className="px-4 py-3 border-t border-border/60 shrink-0">
            {!myAddress ? (
              <p className="text-xs text-muted-foreground text-center py-1">
                Connect your wallet to send messages.
              </p>
            ) : (
              <div className="flex gap-2 items-end">
                <Textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Type a message… (Enter to send)"
                  className="resize-none min-h-[40px] max-h-[120px] text-sm"
                  rows={1}
                  disabled={sending}
                />
                <Button
                  size="icon"
                  onClick={() => void handleSend()}
                  disabled={!text.trim() || sending}
                  className="shrink-0 h-10 w-10"
                >
                  {sending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Send className="h-4 w-4" />
                  )}
                </Button>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
