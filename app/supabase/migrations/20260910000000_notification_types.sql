-- Widen the notification type constraint to the vocabulary the app actually sends.
--
-- The original CHECK allowed ('milestone', 'dispute', 'escrow', 'application').
-- The app has sent 'message' and 'rating' since messaging and ratings shipped,
-- so every one of those inserts was rejected by the database — a chat message
-- and a new review notified nobody, and the failure surfaced as a 500 rather
-- than as anything naming the constraint.
--
-- Kept as a CHECK rather than dropped: the column is written by an API the
-- frontend and the daemon both post to, and a typo'd type would otherwise sit
-- in the table rendering as an unknown notification forever.

alter table public.notifications
  drop constraint if exists notifications_type_check;

alter table public.notifications
  add constraint notifications_type_check
  check (type in ('milestone', 'dispute', 'escrow', 'application', 'message', 'rating'));
