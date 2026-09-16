/**
 * MESSAGES, AS A HEADER ICON RATHER THAN A DESTINATION.
 *
 * Messages first arrived as a sixth entry in the primary nav, which is one more
 * than the bar holds: the navbar already carries a note about the fifth making
 * "Browse Jobs" and "Post a Job" wrap onto two lines on a narrow laptop. It was
 * also the wrong shape of thing to put there. The nav lists places you go to do
 * work — browse, post, your jobs, the numbers. A message is something that
 * arrives, like a notification, and the bell beside it had already settled what
 * that looks like.
 *
 * So: an icon with an unread count, a list of conversations behind it, and the
 * existing chat dialog for reading one. `/messages` stays a real route, because
 * the freelancer page links to it and somebody may have it bookmarked — it is
 * simply no longer the only way in.
 */

import { useCallback, useEffect, useState } from "react";
import { MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChatDialog } from "@/components/chat/chat-dialog";
import { getInbox, isApiConfigured, type Conversation } from "@/lib/api";
import { useMyAddress } from "@/hooks/use-my-address";

function short(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function ago(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function MessageCenter() {
  /* Not `wallet.address`: a managed worker signs in with Google and never
     connects one. They are the half of the marketplace with no other channel,
     so an inbox they cannot open is the one that matters most. */
  const myAddress = useMyAddress();
  const apiOk = isApiConfigured();

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [open, setOpen] = useState(false);
  const [chatWith, setChatWith] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!myAddress || !apiOk) return;
    try {
      setConversations(await getInbox(myAddress));
    } catch {
      /* Leave the list as it was. An icon that empties itself because one poll
         failed is worse than one that is briefly stale. */
    }
  }, [myAddress, apiOk]);

  useEffect(() => {
    void refresh();
    const t = window.setInterval(() => void refresh(), 20_000);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(t);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  /* Nobody signed in has no inbox to show. */
  if (!myAddress || !apiOk) return null;

  const unread = conversations.reduce((sum, c) => sum + (c.unread ?? 0), 0);

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="relative"
            aria-label={unread > 0 ? `Messages, ${unread} unread` : "Messages"}
          >
            <MessageCircle className="h-5 w-5" />
            {unread > 0 && (
              <Badge
                variant="destructive"
                className="absolute -top-1 -right-1 h-5 w-5 flex items-center justify-center p-0 text-xs"
              >
                {unread > 99 ? "99+" : unread}
              </Badge>
            )}
          </Button>
        </DropdownMenuTrigger>

        <DropdownMenuContent className="w-80" align="end">
          <div className="flex items-center justify-between p-4 border-b">
            <h3 className="font-semibold">Messages</h3>
            {unread > 0 && (
              <Badge variant="secondary" className="text-xs">
                {unread} unread
              </Badge>
            )}
          </div>

          {conversations.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              No conversations yet. Clients and freelancers can message each
              other from a profile.
            </p>
          ) : (
            <div className="max-h-96 overflow-y-auto">
              {conversations.map((c) => (
                <button
                  key={c.conversation_id}
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    setChatWith(c.other_address);
                  }}
                  className="w-full text-left p-3 border-b last:border-b-0 hover:bg-muted/50 transition-colors"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-sm font-mono">
                      {short(c.other_address)}
                    </span>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {ago(c.latest_at)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2 mt-1">
                    <span className="text-xs text-muted-foreground truncate">
                      {c.latest_message}
                    </span>
                    {c.unread > 0 && (
                      <Badge
                        variant="destructive"
                        className="h-4 min-w-4 px-1 text-[10px] shrink-0"
                      >
                        {c.unread}
                      </Badge>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {chatWith && (
        <ChatDialog
          open={!!chatWith}
          onOpenChange={(v) => {
            if (!v) {
              setChatWith(null);
              /* Reading a thread marks it read, so the badge has to be told. */
              window.setTimeout(() => void refresh(), 500);
            }
          }}
          myAddress={myAddress}
          otherAddress={chatWith}
        />
      )}
    </>
  );
}
