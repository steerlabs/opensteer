# Opensteer on a phone

This document owns the phone: what the app is for, the surfaces it presents, the Expo
implementations of the shared client's injected ports, and the push notification
path. The connection catalog, the resolver, the session exchange, the credential families and the
protocol epoch belong to the connection stack every client shares; [Connections](connections.md)
and [Host boundaries](host-boundaries.md) describe them, and
`packages/client` enforces them. When code and this document disagree, fix one of them.

## 1. Goal and scope

The Opensteer mobile client is a **client of a Deployment**, nothing more. It reads and steers
work; execution stays on Runners, and nothing about Deployment → Host → Runner ownership changes
because a phone attached. It never downloads, installs or prompts the installation of an app, the
Agent Phone app included.
An Android phone dedicated to agents is a different thing: a computer running the separate Agent
Phone app ([Agent Phone](agent-phone.md)), which this document does not describe and this app
never becomes. `apps/mobile` is Expo SDK 58 / React Native 0.88 with native screens; `ios/` and
`android/` are generated from `app.config.ts` and are not tracked.

The whole surface is one written-out route table (`apps/mobile/src/navigation.tsx`):

| Route                | What it is                                                                                                                                                                                                                                                                                                |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deployments          | The catalog: every Deployment this phone holds, its state and its address, under the platform's large title, with Settings and Add in the bar. First-time setup starts here.                                                                                                                              |
| Home                 | Chat, the root of every Deployment's stack. It renders the permanent Home conversation in place, or the first-message composer before Home exists, and stays mounted under everything pushed over it. Its bar holds the sidebar's Menu and, only while there are tabs or apps to watch, Tabs.             |
| Specialists          | A sidebar destination listing the Deployment's specialized Workspaces, with New specialist in the bar.                                                                                                                                                                                                    |
| Tabs                 | A sidebar destination: every tab, app and phone the reader may see on the Deployment (`placeList`), in their own order. It carries the conversation it was opened from — a task, Chat once it exists, or none — and a tab opened from it talks to that conversation.                                      |
| Specialist           | One specialist, pushed over Specialists, under its name as the large title: its description, the computer holding its files when the Host names it, Start a task (NewTask in that Workspace), and the tasks the Host lists for that Workspace alone, in the sidebar's rows and groups, with Show more.    |
| NewSpecialist        | A form sheet that creates a specialized Workspace with `workspace.create`: a name, an optional icon, and where its files live when there is more than one real answer.                                                                                                                                    |
| NewTask              | A task before it exists: its first message and the AI it starts on, in one Workspace. Sending makes the task, titled from the message, and the task's Thread replaces this screen; leaving makes nothing.                                                                                                 |
| TaskSearch           | Search, pushed from the sidebar's magnifying glass with its field ready to type into: every task the sidebar lists, in the sidebar's rows and groups, narrowed by the native search in the bar, with Show more and refresh. A result opens over the list at any width; Back returns to it as it was.      |
| Thread               | A task conversation: transcript, queued inputs, composer, and a compact open Request with a review sheet. Back returns to the screen it was opened from. A Thread route for the Home Thread goes on to Chat with its exact update.                                                                        |
| ThreadFind           | Searches published conversation messages and opens the exact result in its original context. Return to latest leaves that historical window.                                                                                                                                                              |
| ThreadStep           | One step of an agent's work in full, as a bar-less form sheet read from the live transcript, so a command still running keeps printing.                                                                                                                                                                   |
| ConversationActivity | Run details: a conversation reply's steps, as a form sheet read from the live transcript: the reply under way or the latest, opened from the typing in the transcript, or one reply's, opened from its menu or from a link to one of its steps. Each step opens ThreadStep.                               |
| ThreadSettings       | The model and account picker for an existing Thread, as a form sheet, with explicit review when the change starts a fresh native session.                                                                                                                                                                 |
| NewThread            | The same picker before a Thread exists, for Chat's or a new task's first message. It records each choice as the reader's latest and starts nothing; a blocked remembered choice keeps its name and reason until a live replacement is chosen.                                                             |
| WorkspaceBrowser     | A conversation's tabs and Mac apps, including work it delegated: a grid, or exactly one tab or app named by the route, with the conversation sheet below. Opened from Tabs, one tab over the sheet of the conversation Tabs carried, or alone when it carried none.                                       |
| Computer             | One computer, as a modal from Settings: its status and what it does for agents, then on a Mac its computer use — live sessions with Stop, App approvals (turning automatic off, never on), approved apps with Remove or Block, and pending apps with Decline. Approving and adding apps stay on that Mac. |
| DeploymentSwitcher   | The catalog again, presented as a modal for switching, with Close and Add.                                                                                                                                                                                                                                |
| Settings             | Current Deployment and switching, Computers (where it runs, then each computer in the Computers page's words), Browser (Chrome; Passwords names the Mac that keeps them), Account, Notifications, About, as a form sheet: a native SwiftUI form on iOS, shared behavior and native switches on Android.   |
| Chrome               | Connected Chrome profiles (rename, disconnect) and the sites each Workspace may sign in to, from Settings. Connecting Chrome happens on a computer; the phone says so.                                                                                                                                    |
| AddDeployment        | The three doors into a new Deployment; each begins a different trust relationship rather than a variant of one form.                                                                                                                                                                                      |
| AddServer            | The server-address form. Nothing is added until the address has proved which Deployment it serves.                                                                                                                                                                                                        |
| AddPersonal          | The computer-pairing form, taking a route and a one-use pairing code.                                                                                                                                                                                                                                     |

The three Add routes are one modal group, because adding a Deployment is a task with an end rather
than a place in the app. Presentation is native throughout — the native stack owns transitions,
large titles, search and sheets, `@expo/ui/swift-ui` draws the iOS Settings form — while the
transcript and composer stay React Native, keeping the shared client's behavior and virtualization.

**The sidebar.** Navigation is a leading sidebar over Chat (`apps/mobile/src/sidebar`), not tabs,
and the sidebar is the reader's task list. Every row comes from the model every client reads
(`taskList` in `@opensteer/client/host`), so a task reads the same here as on the web. Under the
head, which holds Search, come the places to go — Chat, New task, Specialists and Tabs — and then the
tasks in groups by what each asks of the reader: Working, with any task waiting on the reader
first and the rest newest started first; Ready, most recently changed first, so its times read
in order; Done, collapsed with its count until opened; and Show more while the Host holds earlier
tasks. Settings and the Deployment switcher sit at the foot. Every row has the task's subject glyph in
its own fixed colour on the left, and state on the right: a working spinner (a static ring with
Reduce Motion), an amber "Needs you" tag, "Waiting", or "Couldn't finish". Unread stays an
independent ember dot; finished rows include their time. Done quiets the title and glyph without
hiding unresolved failure or waiting words. A pending mark or one from an older Host without
colour is a muted document. Chat keeps its own identity and reply/question feedback.
A reader with no task yet sees what tasks are instead of an empty list. Done stays open
or closed as this phone last left it (`done-shelf.json`). A task's long-press and title menus
offer Mark Done or Reopen. Mark Done on work that is not stopped asks “Stop and mark Done?”
and explains that it stops work and handed-out tasks and pauses schedules. Done is shared;
unread Done tasks stay in Ready until read. Tasks never become Done automatically. Chat has
no Done action. The Done composer replaces the input with “This task is Done · Reopen”.
A screen reader
offers the same as an action on the row, whose label (`taskRowLabel`) reads like "Reply to Ana
about the contract, needs you: Approve sending the reply to Ana". Neither Tabs nor the tasks carry
a count, and there are no Automations, which the phone does not have.

It is the one native stack's own `layout`, so there is one navigator, one history and one
`navigationRef`. Where the window has room it is docked: a column beside every screen of the stack,
ending exactly at a fold the system reports, with the conversation beside it. Elsewhere it is
Gesture Handler's `ReanimatedDrawerLayout`: on iOS the screen slides aside to show it, the way the
platform's conversation apps do; on Android it is Material's modal drawer over the screen. Which one
is decided in `apps/mobile/src/layout.ts` from the shell's own measured surface, its reserved
regions (`react-native-reserved-regions`), its safe area and the reader's text size — never from
the device name or orientation — and changing it never navigates or remounts the stack, so a fold
keeps every screen, draft, scroll position and stream. No pane is ever drawn across a fold: one the
sidebar is not docked at leaves the stack on its larger side. Until the surface is measured it is
the drawer, so an unmeasured fold is never straddled; larger text keeps one column rather than
squeezing two; a page or app in front takes the room, so a normal Duo or iPad mini display shows
two panes, not three. On a window that can dock it, the Menu shows or hides the column instead, the
column's head has Hide sidebar, and a task, search, new task or specialist has Show or Hide
sidebar beside Back as a native bar item; the choice is kept on this phone (`sidebar.json`) and
never overridden by room. The list keeps its place when a fold swaps the drawer for the column. Docked, it
covers nothing: Chat and tasks beside it are read as on screen, it marks the open task, and it takes
no screen-reader focus as it appears. A task, search, new task or Tabs chosen from it over anything
but Chat, Specialists or Tabs returns to Chat's mounted route first, so Back never piles up tasks.
Tabs still carries the conversation it was chosen over — a task, the conversation under a tab, Chat
once it exists, or none — so returning to Chat's level never swaps a task for Chat, and a tab's
occupants never choose one. Its drag and settle run on the UI thread and follow the system's Reduce Motion setting;
React hears only where a movement starts and ends. It opens from the Menu on Chat, Specialists and
Tabs, or by dragging from the leading edge there; those destinations therefore have no Back swipe of
their own, while every task, search, specialist and watcher keeps its native Back. The Menu carries
the number of questions waiting on the reader, in the same amber, so a question asked in some task
shows from Chat without opening the sidebar. Choosing a destination, a task, a link, a sheet or
another Deployment closes it, as does the Host attachment being released or replaced or another
person signing in to the same Deployment; so do the scrim, Android Back and the VoiceOver escape
gesture. While it covers the screen it isolates itself for screen readers, and Chat counts as not
being read: no read marker advances and alerts about Chat are still presented. The tasks and the
count come only from the attached Host of the Deployment underneath, never from one the selection
is leaving, and the sidebar reads its tasks only while it is on screen.

`apps/mobile/src/navigation.tsx` is the route table alone; screens reach the root through
`navigation-ref.ts` and set their bars through `navigation-header.tsx`, so no screen imports the
table that imports it.

The Computer page also names the Mac's desktop page when its approval key has not been
registered. The owner opens that page in the Opensteer desktop app on the Mac to register
the key; the phone cannot register it or approve a request. A pending app request can still
be declined on the phone. For an agent phone, the Computer page offers the same access controls
as web/desktop and Stop for the holding task; pending phone access Requests offer Allow and
Decline. It has no app list or App approvals policy. [Agent Phone](agent-phone.md#7-access-and-stop)
owns those controls and their owner-command contract.

**A Deployment is persistent context.** The phone remembers one explicit selection in
`selection.json`; the catalog is not the everyday home screen. Opening another Deployment clears
screens belonging to the previous one, and a thread link installs that Deployment's Chat beneath
its Thread, so Back cannot cross into another Host's work. Search and the wide-layout detail are
scoped to the selection; offline and sign-in-required states recover inside that context rather than
choosing another Deployment. Startup waits only for local catalog and selection hydration, with Host
verification and Account directory refresh continuing after the remembered context is visible. A
fresh installation can choose its sole deployment once; an explicitly cleared selection is distinct
from a missing preference and is never replaced automatically. Signing out retains the context and
asks for sign-in; removing the Deployment clears the selection.

**Conversation first.** A healthy connection has no selector or status strip on Chat: the selected
Deployment appears at the foot of the sidebar and in Settings, and connection recovery names it when
a person needs to sign in, retry or switch. Status lives in the header subtitle, where the shared
connection model separates platform-reported `Offline` from an `Unavailable` deployment and offers
Retry only for the latter; Runner availability is separate, because an offline computer still
permits server-queued messages. Entering a Deployment opens Chat, which never navigates on its own:
explicit task and notification links keep the destination they name, and a link about Chat itself
arrives at Chat with its exact update. The first-message composer mounts only once the signed-in
person is known, keyed by them, and offers at most two editable examples. When the only thing a
first message lacks is which AI to start on, Send asks that. Only a Host-confirmed choice from that
picker visit can finish the send, including when Done precedes the confirmation. Closing without
choosing cancels the send; a later preference change cannot send the saved draft. It stays in front — even
once another device has created Home — while this phone holds a first message for it: one handed to
the Host, or saved words, a quote or files. A conversation's bar shows only a header reported under
the current Host attachment, reader and Thread. Everything that returns to
Chat — the sidebar, a quote from a task, Find, a message's source — returns to that one mounted
screen, so its draft, scroll position and pending send stay where they were. The pane in front of
the reader claims the Host's active Thread as it comes into view, so a mounted Chat beneath a task
does not hold it.

**A task begins with its first message.** The sidebar's New task and a specialist's Start a task
open NewTask, which, like Chat before Home, is a real draft and a real choice of AI with nothing yet
on the Host (`apps/mobile/src/thread/first-message.tsx` holds what the two share). Sending writes
the message and the exact `thread.create` command, under its own idempotency key and titled from the
message, to this phone before either leaves it; the task is made, the message is handed to the
task's own composer under the key it was claimed with, and the task's Thread replaces NewTask. A
retry repeats both commands, so a lost answer returns the task the Host already made; a refusal
returns the words and files to the draft. Leaving while the task is being made does not strand it:
NewTask sends the message itself under the same key, and one it cannot send waits for the task's
composer. Opening NewTask and leaving before sending makes nothing, and its draft waits for the next
visit to that Workspace.

**Needs you.** A Request waiting on the reader shows on the task it holds up, as that task's amber
"Needs you" row at the top of Working, from `snapshot.waitingRequests`: the Host's complete list of pending Requests this reader
answers. Opening the task docks the Request above its composer, and Chat's own questions mark the
Chat row. A Request stays until the Host says it is no longer pending; answering from the phone does
not clear it early. The Menu's count is `attentionCount`: each Request once, however many tasks up
its chain it holds up, including any asked in a task this phone has not loaded.

**Task and specialist marks.** A task's bar shows its subject glyph and title, with its
specialist's small tile and name underneath when it belongs to one. The title's native Task
menu offers Change icon beside Rename. Change icon opens a searchable grid of all 130 shared
icons; Use default chooses the document permanently, independently of renaming. Command failures
stay in the sheet so the person can retry. Chat has no icon-edit action. A Host without
`task-marks-v1` hides icon and colour editing. Specialist creation offers seven colour swatches;
an active owner can tap a specialist's tile to edit its icon and colour unless it is being deleted.
Membership is checked on screen focus, foreground return and after a refused edit; other readers
get the labelled tile. Tiles use the chosen colour, or a neutral fill when absent. Assignment cards
show the task's mark separately from its owner's tile and name, using Opensteer's orb only for known
Main ownership and omitting attribution until an unknown Workspace loads. Changing a specialist's
colour does not recolour its tasks. Pickers hide before being released: iOS returns accessibility
focus after native dismissal, and Android on the next frame. The native task menu's accessible name
includes connection health ahead of assignment state, matching its visible subtitle; Retry stays
separate. The marks are decorative for accessibility; task labels retain the title and state words, and
native menus and pickers keep targets at least 44 points on iOS and 48 dp on Android.

**A task's own title.** Work another conversation handed out says where it stands in the bar,
never above the composer, which holds only what the reader acts on next: a docked question, the
conversation's live tab, the queue and the message being written. The line under the title gives the shared
`assignmentPresentation` word with its mark — a green dot that breathes only while a Run is working
now, amber when it needs the reader, the system's glyph once it has ended — and gives way to
connection or computer trouble, which is what the reader can act on. Completed is the exception
when the title has a menu: the menu's header and the title's accessible name already say it, so the
bar keeps one line for the title (and the specialist, when there is one). A title without a menu
keeps the word, since the drawn transcript can be a window from before the ending. The title is a
pull-down (`apps/mobile/src/thread/task-status.tsx`) whose header says who asked and what the word cannot,
with Rename… on every non-home task when the Host supports task titles, including tasks nobody
assigned. Rename opens a text-entry dialog on iOS and Android; blank or unchanged names cancel.
Assigned tasks also offer Open for their source conversation and Stop Task…, which ends the task
for good after the same action review as the task's card; the composer's square only pauses it. How each task ended stands as one
line under the turn that ended it and opens the conversation the result went back to. The bar's title is the only heading a task has.
A turn that answered folds its steps behind its "Worked for" line, which opens them in place around
the reply; one still working, waiting, failed or stopped keeps them in view (`turnFolds`). A long
sent message folds inside itself behind Show more at the line count `messageFoldLines` gives. Both
rules are the shared client's, so every client folds the same turns and messages.

The composer is one capsule bar docked at the bottom. Its AI control is one capsule: the engine's
mark and, in words, the engine, the model and its reasoning level, red and "Unavailable" when the
choice cannot run. It opens the model sheet, which also holds the choice's settings: each model
option, and Access, with the modes the engine cannot enforce named and left unavailable. In
conversations such as Chat, AI settings in the composer's menu shows that control; Work Threads
grow it as a second row while the field is live. Both presentations and the model picker share the
Thread's mutation ownership through `thread/thread-mutation-registry.ts`, so a change in flight
blocks Send until the Host answers, and neither silently replaces a choice: an unavailable model or
account is explained, and a half-made pair whose model or account leaves the catalog returns to the
start with the reason. The preferences behind those choices belong to the Host, one record per user:
the phone reads `snapshot.executionPreferences` and keeps no local copy, a Thread change goes
through `HostClient.updateThreadExecution` or `updateThreadAccess`, the New Thread picker writes
each choice through `HostClient.rememberExecution`, and a blocked remembered choice never falls back
to another computer or account without asking.

Drafts stay editable offline while sending and decisions require an authenticated connection, and
they are scoped by Deployment, authenticated user and Thread, as are pending sends. Mounted views of
the same draft subscribe to one store, so returning through task history or from a full-screen task
to an iPad detail keeps the latest words, quote and files. Attachment updates merge by file
identity, so a late upload cannot restore a file another view removed. Pending delivery is shared
across views, and acknowledgements clear only the command whose idempotency key they name. Schema 3
(`drafts-v3.json`) added that user scope; schema 2 recorded no owner, so the prior `drafts.json` is
left untouched and never read. Sending never answers a Request. Schema 3 could also hold a "decline
the approval and send this" pair; schema 4, in the same file, drops the saved decision rather than
sending it, and keeps the message, which had not left the phone, as an ordinary pending send under
the key it was saved with. Its files and quote were still in the draft, to be taken when it was
sent, so words saved beside them stay there with them until the person sends them together.

**The Thread's durable inbox.** Human Send always queues; the Host decides what that means. In a
work Thread a message sent behind a running turn waits in a tray tucked above the composer, not in
the conversation: `apps/mobile/src/thread/queued-messages.tsx` lists the queue the shared client
keeps in `snapshot.inputQueues`, one row per message with Steer where the Host says it will take the
message into the running turn and Remove where the message is the reader's to take back;
`visibleTranscript` keeps those messages out of the transcript until a Run takes them. Steer and
Remove are `HostClient.steerThreadInput` and `cancelThreadInput`, which hold one idempotency key per
attempt so a lost answer is retried rather than manufacturing a second mutation, and patch the
snapshot's queue at once. A paused queue is a line at the top of the tray whose Resume is
`HostClient.resumeThreadInputQueue`. A conversation such as Chat has no tray: the Host hands the
person's message to the reply under way, and one it has not handed over yet is drawn as a sent
message at the end of the conversation (`visibleTranscript` with `conversation`). The policies and
what promotion means are owned by `docs/agent-orchestration.md`.

Requests stay visible as a compact title and Review action; details, risk and response controls live
in a native review, where Close dismisses without submitting and keeps an unfinished form. A retried
response keeps its original idempotency key, and admission does not mark a Request resolved
locally — the Host's state remains authoritative. Transcript links follow the clients' shared
[`transcriptLinkUrl`](../packages/shared/src/transcriptLinks.ts) rule, so generated content cannot
invoke the app's deployment-switching deep links. An
`integration.access` Request opens `apps/mobile/src/thread/integration-connect-sheet.tsx`, which
runs the browser's own connect flow against the same Host through
`MobileClient.beginIntegrationAuthorization` and `beginMcpIntegrationAuthorization`: the system
browser's return is only a wake-up, and the durable attempt is read back with this phone's Host
credential. A `browser.access` or `browser.profile.save` Request is answered in full: choose which
saved profile the Workspace may use (one it already has completes at once), create one, or name a
fresh session's sign-ins, with the same model and copy as the web
(`packages/client/src/host/browser-access.ts`). A `browser.password-sign-in` Request is approved
only on the Mac it names, in Opensteer Passwords, so the phone names that Mac, shows the agent's
reason labelled as the agent's and when it expires, and offers only Don’t allow
(`browser.password-sign-in.decline`, settled by the Mac's answer); a settled one says how it ended,
in the web's words (`packages/client/src/host/passwords.ts`). Turning a computer app on for one computer is the
same decision, in
`thread/computer-app-picker.tsx`. Agent Phone is a separate Android Runner app; the mobile client
can decide its access as described above. See [Computer apps](computers.md#computer-apps).

**Tabs and apps.** A conversation's Tabs (the bar's Tabs) lists its tabs,
Mac apps and phone displays from the shared model (`conversationSurfaces`): every tab of the
sessions whose durable use records name the conversation, and apps on a Mac the reader owns that a
Run of the conversation, or of work it handed out, holds now — one tile per tab, app per Mac or
phone, read with that conversation's own task sessions. Sessions are internal and never shown. Tabs
keep session creation order, then tab order with popups beside their opener. The bar's Tabs shows
only while there is one, and always opens this collection, titled Tabs with the conversation's name
under it; Back returns to the conversation. The sidebar's Tabs lists everything the reader may see
(`placeList`, as web and desktop read it): tabs opened by hand on a computer, tasks' and delegated
work's tabs, saved tabs, task-held apps and the person's own Mac and phone views, in the person's
order. It has no scope switch: where it was opened from says which conversation a tab opened there
talks to, and nothing is chosen from who is in a tab. Before Chat exists a tab opened there is
shown alone, and nothing creates a conversation.

The route is the only selection: a tile, a transcript chip or the composer's preview pushes exactly
one tab or app (`surfaceRoute`, or `workspaceRoute` from Tabs), and Back returns to where it was
opened. Mobile browser routes require a tab; notifications and deep links open conversations. A tab
is found by its own id, as the web finds it. A saved tab — kept by its browser and not running —
restores on its saved computer through the client's one activation owner
(`HostClient.activateWorkspaceTab`), which waits for the connection and the computer and keeps one
attempt per tab: the page says "Opening…", "Waiting for" its computer, the lasting reason it cannot
open (nothing is asked), or the failure with Try again. The answer moves the route to the restored
session with `setParams`, which remounts neither the conversation nor the route; an answer that
arrives after the person left, or for another account, navigates nothing. A lineage the bounded
catalog leaves out is read once with `readWorkspaceTabs`. An ended, closed or missing tab stays on
screen as "This tab was closed", with Back to tabs when the collection holds another; a failed page
shows its detail. Nothing substitutes a sibling or automatically navigates away. Tiles share one
picture shape, so a new frame never reflows the grid; two columns on an ordinary phone, one on a
narrow pane or with larger text, measured from the pane and the reader's text size. Each shows its
exact tab's picture — none for a saved tab — with its title and site; only a tab an agent acts in
has the green ring, and one that cannot open is dimmed with its reason in its accessible label.
When two or more browsing identities are in view, a profile initial in its shared tint or Guest's
dashed ring joins the site, and the accessible label includes that identity's name.

Above the composer of Chat and of a task, one compact preview shows the conversation's live tab:
the tab an agent of it — its own or one it handed work to — acts in, newest first; else the Host's
latest place for it (`useThreadPlace`) when that is one of its tabs; else its newest tab. It holds a
picture for two seconds before following an agent to another tab, as the web's viewfinder does, and
drops a tab that ends at once. A press opens exactly the tab under the finger as it landed; "+N"
opens the conversation's Tabs. It is absent with no tab, under a page and while the keyboard is up,
reads only the conversation's tabs and latest place so streamed text never redraws it, takes its
picture only while the conversation is in front, connected and in the foreground, and appears and
leaves with the system's Reduce Motion setting. An agent moving never changes a page the person
opened.

Only visible, focused, foreground grid tiles retain the passive Watch feed for their exact tab
(`retainBrowserWatch`, `browserWatchFrames`); an opened page retains its tab's interactive channel
(`retainBrowserViewer`, `browserFrames`). Each channel's own readiness controls input. Both feeds
return picture credit after load or decode failure, when discarding a decoder slot or a wrong-tab
picture, and when leaving before a native callback arrives. Tapping clicks through the scaled
picture; dragging scrolls. After a tap, negotiated editing sessions offer Keyboard when the control socket publishes an
editable field. They use the native Expo text proxy at `apps/mobile/modules/remote-text-input`,
including secure field traits and ordered native composition/input events, through the shared
client editing reducer and transport. Baseline sessions offer plain typing, Backspace and Return
with correction and spellchecking disabled; they refuse replacements that need verified ranges.
The module's README owns the native adapter and device-qualification contract.
There is no tab strip. The top bar shows the page's title and site; its menu holds Back, Forward,
Reload, New tab, Fit page, Sign in with Chrome on web pages, and Close tab. New tab uses
`openBrowserTab`, replaces the route with the returned tab in the same scope, and opens its blank
address field. Close tab uses the shared reviewed action, asks first when an agent holds work there,
then returns to Tabs, or to the conversation when nothing of it remains. A saved tab offers Close
tab through `closeWorkspaceTabs` without waking its browser; a failed close retries that same
operation. Human and agent input remain concurrent.
The native text-input module requires a rebuilt custom client; Metro exports verify
bundle resolution and do not qualify native keyboard or shared-input behavior.
The app never sizes a page by itself: it scales the picture, and Fit page is the explicit fit
([Browser sessions](browser-sessions.md#shared-viewing-and-previews)). Leaving or backgrounding
releases the channel. JavaScript prompts belong to their exact tab and dialog ID; accepting sends
its text and that ID together.

A page is as tall as its own shape at screen width and sits at the top; the conversation sheet takes
the rest. Folded, the sheet names the conversation it talks to under its handle, then shows Opensteer typing or the latest reply line (or "Ask about what you see"), one amber
"Needs you" line for anything waiting on the reader, and the composer, which includes the page as a
`browser-page` part ("Ask about this page…"); opened, it shows the transcript with the waiting
questions in full. Transcript chips name the page a
person included with a message and the pages and apps a reply's Run used (`messagePages`,
`runPages`, `turnApps`, `turnPhones`), each opening exactly that destination. App and phone chips
come from recorded steps across the reply's stretches and delegated work, so they stay named and
disabled after their sessions end or the client disconnects.

That stacked sheet is one of three arrangements of the same page and conversation, chosen by the
page view's own measured surface and reserved regions (`derivePagePair`): with room for both, the
page leads and the conversation is beside it, open, aligned to a vertical fold when there is one;
with a horizontal fold the system reports and useful halves, tabletop puts the page above the fold
and the conversation below. Unmeasured, or with larger text that leaves no room, it stays stacked.
Changing arrangement remounts neither the page's channel nor the conversation, never navigates, and
keeps the reader's own choice to open or fold the sheet for when it is stacked again. Beside or below
the page the conversation's name heads it. The keyboard
belongs to the pane typing — the page while its address or keyboard is up, the conversation
otherwise — and only that pane makes room for it; in tabletop the page gives up its half while the
composer types, so the composer is never left without room. A fold the pair is not split at keeps
the pair to its larger side. The page's address, dialogs and picture keep to the page pane's own
insets. A touch begun on the page is dropped if the picture changes size or moves, or the pair is
rearranged, rather than aimed at the old geometry.

A Mac app opens in the same route: its live picture through `useComputerUseWatch`, one at a time,
acknowledged after its Image loads, reading only while focused and `AppState` is `active`, and
dropping both its displayed and decoding pictures when the app becomes inactive. Focused views
and grid previews also clear both slots when capture reports a locked Mac, a minimized or closed
window, an unavailable phone display, or lost access. The person's own view of an app or phone,
opened from Tabs, is read by its exact view id and generation and kept alive
(`retainComputerView`) only while it is in front; once it closes or is replaced it says "This view
has ended" and never falls back to a task holding the same app. Starting a browser, choosing a
profile and profile management remain in the web and desktop apps; the phone only restores a saved
tab the person opens.

Stop comes from the shared client store (`computerUseStops`, `useComputerUseStop`), so the Thread's
line, the Mac app view and Settings → Computer show the same Stop. The Host answers as soon as it has
taken the Run's authority on that Mac back, so Stop is quick and pressing it again is always safe: a
Stop that failed says why beside the button, which stays enabled as the retry. After its session
leaves, the line keeps `Stopping…`, then `Stopped using` the Mac for three seconds; a failed Stop is
not kept once its session is gone, since nothing is left to stop. Stops are cleared when the
signed-in person or Deployment changes.

Deliberately not in v1, each for a stated reason rather than for lack of time:

- **Files and terminal.** Each is a second protocol surface and a second UI to keep in step with
  the web app, which already owns them. A screen earns its native version.
- **Multiple simultaneous Deployment sockets.** One attachment at a time (§3). N enabled
  Deployments means N reconnect storms per network change and N radios' worth of battery, and push
  does not need them: a notification names a Deployment and the app attaches to that one.
- **Offline queueing of approvals.** `canRespondToRequests`
  (`packages/client/src/host/host-connection.ts`) is false unless the socket is `connected` and the
  Host has authenticated the user; a decision made against stale state and replayed later is worse
  than a decision not offered. Sends are different: the composer writes its text and its
  `mutationIdempotencyKey` to disk before the command leaves, so a lost answer is retried as the
  same command rather than queued as a second one.

## 2. Model

The public stable Mac app offers Private network access and pairing codes without
an Opensteer Account. A phone can pair over that reachable HTTPS address. Connect,
Account discovery and phone push from that Mac are unavailable until an Account
service ships; local desktop notifications and live in-app updates still work.
Beta continues to use its staging Account.

A phone always resolves with a **null local runtime** — the owner arm belongs to the computer at
the keyboard — so `describeConnectionAccess(connection, null)` decides every row
(`apps/mobile/src/client/deployment-rows.ts`).

| Arrangement                     | Access arm | Credential family                        | How it is added                         |
| ------------------------------- | ---------- | ---------------------------------------- | --------------------------------------- |
| Managed cloud                   | `native`   | `Bearer`, the Host's own native OAuth    | Account directory                       |
| Independent self-hosted server  | `native`   | `Bearer`, the Host's own native OAuth    | Its address, verified before anything   |
| Personal via Connect            | `connect`  | `PersonalRemote`, Account-grant exchange | Account directory                       |
| Personal via private route      | `private`  | `PersonalRemote`, pairing-code exchange  | Its route and a one-use pairing code    |
| Personal with remote access off | none       | none                                     | listed, `Unavailable`, no socket opened |

`createDeploymentCredentials` (`apps/mobile/src/client/deployment-credentials.ts`) reads exactly one
family per Deployment — OAuth for `self-hosted`, the stored session for `personal` — and never both,
because the Host parses the two with different parsers and mixing them would let one stand in for
the other. [Host boundaries](host-boundaries.md#credentials-and-machine-local-ownership)
defines the families and machine-local ownership. The Account is a directory
and a grant issuer, not an authentication authority for any Host; a Deployment with no Account is
fully usable through the two manual doors and simply gets no push (§6).

## 3. The shared client on a phone

Every platform capability `@opensteer/client` needs arrives as an injected port;
[Connections](connections.md) describes the shared layer. The phone's implementations are:

| Port                 | Expo implementation                                              |
| -------------------- | ---------------------------------------------------------------- |
| `ClientLifecycle`    | `apps/mobile/src/platform/lifecycle.ts`                          |
| transport            | `platform/host-network.ts` + `platform/react-native-socket.ts`   |
| `PrivateFilesystem`  | `apps/mobile/src/platform/private-filesystem.ts`                 |
| `ProtectedAuthStore` | `apps/mobile/src/platform/secure-auth-store.ts`                  |
| entropy and abort    | `apps/mobile/src/runtime.ts`, the first module the entry imports |

`openExternal` and `OAuthDeepLinkBroker.accept` are function parameters rather than an interface; on
a phone they are one call, because iOS and Android hand the redirect back to the caller of an
authentication session (`platform/authorization-browser.ts`), and `LocalHostRuntimeSource` /
`LocalOwnerSession` stay desktop-only because a phone passes null. `runtime.ts` installs the two
things the shared client assumes and neither Hermes nor Expo's runtime provides — `globalThis.crypto`
bound to `expo-crypto`, and the `AbortSignal` instance members the Account and Host authorization
leases use (`platform/abort-support.ts`) — both unconditionally, so there is never a question of
which implementation is in use.

**One active attachment.** `MobileClient` (`apps/mobile/src/client/mobile-client.ts`) is the one
owner: it holds the catalog, the credential stores and the selection, and creates and disposes the
single `HostClient`. Changing the selection bumps a monotone generation and disposes the previous
client before the next exists, so two Hosts are never subscribed at once and a slow attachment that
lost the race disposes itself. No screen constructs a client, opens a socket, or reads a credential.
The phone sets `prefetchHome`, so authenticated bootstrap starts Home history through the shared hydration owner and Chat
joins that read when activated; prefetch neither claims Chat nor marks it read, including
while the sidebar covers it.

**The Host's answer outranks the record.** A credential this device holds is not a credential the
Host still accepts: a session revoked from a browser leaves the record untouched, so a row reads
`Needs sign-in` while the attachment reports `authentication-required`. That state is latched — the
client was refused and never asks again — so a credential that lands later reaches the Host by
**replacing the attachment**, triggered by the credential arriving and never by `beginHostSignIn`
returning, which resolves while the code has still to be exchanged.

Attachment also establishes a missing Connect session rather than treating a missing local record as
the final answer: after route verification one attempt may exchange the Account's grant, store the
returned `PersonalRemote` credential and continue into the same fenced attachment, saving only after
rechecking the selection attempt, the attachment fence and the authorization epoch. Sign-out,
removal, Account sign-out and disposal advance that epoch synchronously, before any awaited
revocation or storage work, so a late exchange cannot restore what they cleared. An Account or
admission failure stays `Needs sign-in` and a transport failure reads `Offline`; neither is retried
inside that attempt. Successful `signOut` persists a suppression in private app storage, loaded
before startup restores a selection, so reconciliation or a restart cannot undo a sign-out.

`select(deploymentId)` is the non-interactive operation used by startup, directory singleton
selection, deep links and catalog reconciliation: it never opens a browser. A row tap uses
`openDeployment(deploymentId)`, which selects first and starts Host-native OAuth only when route
verification returns a current `needs-credential` outcome for that exact selection attempt and fence
generation; an identity mismatch, protocol mismatch or superseding selection ends the open without
an authorization request. `signIn(deploymentId)` may start OAuth without opening the Deployment, but
refuses a stored live-verification verdict and names the repair. The authorization browser asks for
a non-ephemeral session, so Host OAuth federating to the Account can redirect rather than ask again.

## 4. Lifecycle

`ClientLifecycle` (`packages/client/src/host/lifecycle.ts`) is the whole of what `HttpHostClient`
needs from a platform: `getSnapshot`, `onBackground`, `onForeground`, `onNetworkChange`.

- **Background stops timers, not sockets.** The refresh poll and every reconnect timer stop; the
  sockets stay. The OS may tear them down, and discovering that on the way back is cheaper than
  closing sockets that are still good. Picture sockets are the exception: browser pictures and
  computer displays pause while hidden, keep their last picture, and reopen on the way back.
- **Foreground probes or replaces at ten seconds.** Backgrounded for less than
  `socketTrustWindowMs` (10s) and not offline, a live socket gets a correlated `client.ping` with a
  `socketProbeDeadlineMs` (3s) deadline and is kept if it answers. Past the window, or with no
  probe to run, it is replaced outright — mobile platforms close backgrounded sockets without
  delivering a close event. A platform states its own window through the lifecycle: the Desktop
  renderer's sockets live in desktop main and survive a hidden window, so it always probes.
- **Every network notification invalidates.** Wi-Fi to cellular reports `online` on both sides and
  still kills every socket, so the platform must deliver the notification rather than filter
  repeats and the client replaces every channel on each one; the single exception is a repeat of
  `offline`. The Expo adapter (`apps/mobile/src/platform/lifecycle.ts`) also re-reads network state
  on every foreground, because `expo-network`'s listener is told nothing while the process is
  suspended. A foreground reread matching the last known network type and reachability does not
  emit a second notification; listener notifications still always do. Only `AppState === "active"` is foreground: `inactive` is the switcher or a system
  prompt, and treating it as backgrounded would drop sockets whenever a notification slides down.
- **A quiet channel is asked whether it is there.** While the client reads, a synchronized
  Workspace channel whose own subscription has sent nothing for `realtimeIdleProbeMs` (25s) gets a
  `client.ping` with a `realtimeIdleProbeDeadlineMs` (10s) deadline and is replaced if it does not
  answer. A channel that cannot be asked (connecting, never synchronized, or no longer open) is
  replaced with backoff after the same 35s. Notices addressed to the person do not count, because
  they arrive on every socket whether or not its subscription still delivers; the Host keeps that
  half by closing any socket it stops delivering to.
- **The cursor is retained.** A replaced Workspace channel resubscribes from its existing
  `afterSequence`, so the Host sends the delta. A full resync happens only on
  `host.resync-required`, which is the Host's word and the one thing that resets the cursor.

### This iPhone's apps

An iPhone can lend its own Calendar, Contacts, Reminders, Location and Photos metadata to the one
Deployment it was added to;
[iPhone apps](iphone-apps.md) describes the native executor. In JS, `IphoneAppsController`
(`apps/mobile/src/iphone-apps/controller.ts`) decides when to ask the native bridge for what, and
the composition root builds exactly one. Opening another Deployment changes only which session the
controller may use; it never stops or moves the iPhone.

- **Stopping is synchronous.** Signing out of the iPhone's Deployment, removing it, an Account
  sign-out of a Deployment the Account lists, and any catalog change that drops it all call the
  native `disconnect()` before their first await, through the owner port `MobileClient` takes as
  `iphoneApps`. Then, while the credential is still held, the Host is asked to revoke the machine,
  bounded to ten seconds. A Host that cannot be told never holds up or undoes the stop; the person
  gets a notice to remove it from another device.
- **Every outcome is fenced.** Stopping advances a generation, and an add, approval or registration
  that crosses an await from an older generation changes nothing. An add mints at most three
  enrollments with the iPhone's stable key, retiring each dead one before the next. It never mints
  on a Host without `iphone-apps-v1`, or while another Deployment holds the iPhone.
- **Only a reviewed tap prompts or signs.** An app's sheet offers its access levels as radio
  choices; choosing one is a draft, and only the review's button commits it. Closing the sheet sends
  nothing. iOS is asked only from that commit, a task request's Allow or a remedy's button, and its
  answer is read back: if iOS does not let Opensteer use the app (Calendar's add-only access
  included), nothing is requested or signed, and a task's request keeps waiting rather than being
  declined. Limited Contacts and limited Photos are enough, and closing either picker is not a
  refusal; Location has no limited access. A signature is requested only for the exact request the
  iPhone currently lists, at the reviewed app and access.
- **New setup checks both sides before iOS is asked.** The installed build offers an app only when
  its snapshot reports that app's permission; an older build omits Location and Photos, and the
  controller never prompts, requests, signs or opens a picker for them. Turning an app on also reads
  the Host's catalog (`integration.platform.get`) first: an older Host that doesn't list the
  definition, or a catalog that can't be read, stops before iOS or the Host is asked. For an existing task request, the controller also checks the catalog before a new Location or
  Photos prompt when the enrolled Deployment is open. A known missing definition stops the prompt.
  If another Deployment is open or that catalog cannot be read, the native request remains
  answerable; a Host rollback can then cause one person-triggered iOS prompt before the Host
  refuses the obsolete request. No access is granted. An unavailable app's row says which side to
  update; lowering, turning off and declining stay available.
- **Location and Photos are read only.** Their sheets offer only Can read and Off. Location's review
  and request say that Allow Once ends a while after Opensteer leaves the foreground, which then
  reads as not asked again, and that approximate Location is used and labelled when Precise Location
  is off. Photos' review and request say that iPhone's library prompt is broader than the read-only
  details agents get, and that a photo itself is sent through a chat attachment.
  The approval key is registered at most once per transition to online. The iPhone's address is
  compared with the Deployment's once per attachment.
- **Success is the Host's answer; a lost one is read back.** An app keeps its current access while
  more is being added. When the Host's reply to the request or to the signed answer is lost, the
  controller reads `integration.computer.setup.list` and `integrations.get` instead of asking
  again: a connection covering the access is success, the same request still waiting goes on to be
  signed (once per tap), and no request means nothing changed. If neither can be read, the app shows
  **Approval not verified** with **Check status**, and each reconnect reads it back once without
  signing. A row is green only when agent access, iPhone Settings and the connection all allow use.
- **Narrowing needs only the Host.** Lowering, turning off and declining work from any of the
  person's devices, while the iPhone is offline and while a request for more access waits; the
  shared `iphoneAppStatus` words them the same on web and mobile. Turning off stops new use and
  never claims to undo returned data or completed changes.
- **A request is shown on its own once.** The ids already shown are kept in
  `iphone-approvals-shown.json` until they expire; the request stays on the iPhone's Computer page.

Mock mode runs the same controller over `fake-bridge.ts`. That fake joins the in-memory Host of the
Deployment it is added to, and mock mode keeps one such Host per Deployment. The controller tests
and rendered flows in `apps/mobile/src/iphone-apps/` use the same fake. They prove sequencing and
words, not Swift, iOS prompts or a real Host.

## 5. Compatibility

**The generated iOS app owns a scene, not a process window.** The iOS 27 SDK refuses to launch an
application that has no UIKit scene lifecycle. Expo SDK 58 generates `SceneDelegate` using
`ExpoAppSceneDelegate`: it starts React Native when UIKit connects the scene, rebuilds cold-start
URL and user-activity launch options, and forwards lifecycle and warm link events through Expo
and React Native. `app.config.ts` explicitly disables multiple scenes so resizing retains one
navigation history and draft owner. Generated native projects must keep this upstream lifecycle
as their sole owner. Reuse one native journey for each affected flow (links, OAuth or
notification entry), with cheap lifecycle regressions for edge cases. Lifecycle tests use a fake app
state, and successful prebuild or bundle export does not verify native callbacks: cold and
warm links, OAuth completion and cancellation, notification taps from terminated and
background states, and foreground/background callbacks remain manual acceptance or release checks, which keep artifacts only for the flows they
consume ([Testing](testing.md#how-to-test)).

[Host compatibility](host-boundaries.md#compatibility) defines the protocol epoch
and mismatch handling; never write an epoch number into this document. On the phone, verification runs
beside the attachment rather than gating it (`apps/mobile/src/client/host-port.ts`), because a Host
that cannot be reached is a connection state and not a version answer; the row reads
`Update required` only when a live descriptor said so, and names which side to update. It is probed
through the **resolved route**, never the canonical origin, which for a Personal computer is the
owner machine's loopback a phone cannot reach at all. Identity is compared after the probe rather
than handed to it, because "this route produced no document" and "this route produced another Host's
document" are different things to tell a person, and a verdict is discarded unless the attachment
fence is still on the generation the probe started on.

## 6. Notifications

### What notifies

A person is notified when Opensteer messages them: the final reply of a Run that answers them
directly, whatever started it — the person, a reminder or other automation, a task result, an
answered Request. A task's reply returns to the agent that assigned it, which relays it, and a
channel Run answers in Slack or iMessage, so neither notifies. A person is also notified when a
Request waits on them, and when a Run they were waiting on fails or stops without anybody asking.
A report never notifies: it is context for an agent's next turn. The rule lives in
[notification-store.ts](../packages/database/src/notification-store.ts). A notification's id is
derived from its person, kind and subject (the reply, Request or Run), so two events naming one
reply share an id; clients and the Account drop the repeat, and each person hears once.

Muting a Workspace silences replies and failures in its Threads; Requests still alert. A reply
the person has already read is not notified. An automation whose only scheduled run fails, or
that pauses after repeated failures, tells its anchor Thread through a platform continuation
([automation-failure-service.ts](../apps/host/src/triggers/automation-failure-service.ts)), and
that Thread's reply is what reaches the person.

### Deciding and delivering

[`NotificationDispatcher`](../apps/host/src/notifications/notification-dispatcher.ts) decides when an
event commits: `publishWorkspaceEvent` hands it every committed event, and an event that may notify
is decided against current state right away. Alerts are best-effort and the conversation is the
durable record, so nothing about a notification is stored on the Host and nothing replays: an event
older than `notificationPushWindowMilliseconds` (fifteen minutes) never notifies, which also keeps
anything recovery republishes after a restart quiet. A Host that dies between a commit and its
alert, or during the hold and retries below, loses that alert; what it named stays unread in its
Thread.

The Host sends each decided notification to its person's connected clients at once as
`host.notification` (Host API epoch 30). Web and desktop show an operating-system notification
titled with the Thread ("Opensteer" for Chat) and an excerpt of the reply, Request or failure,
unless the window is in front with that Thread open at its latest message. A newer notification for
a Thread replaces the older one, and a click opens the Thread, at the reply when it names one. Each
open browser tab receives the notification and one shows it. Browser permission requires a
person's gesture.

Phone push needs an Account channel: an attached server Host's configured Account, or a Personal
Host's active Account link, read before every attempt. A reply waits five seconds first, so reading
it on another screen keeps the phone quiet; Requests and failures go at once. Each attempt then
waits for the Account to hold this Host's published identity, rereads membership, mute, read
position and Request status, resolves the person's Account subjects, and posts. A network failure,
5xx or 429 is retried after 1, 2, 4, 8 and 16 seconds; any other answer, exhausted retries or a
closed window is logged once and dropped, and `push-not-configured` is logged as a warning. A
person with no Account subject is skipped quietly. Publications carry only identifiers and the
fifteen-minute window, never prompts, titles, output or credentials;
[notification-message.ts](../apps/control-plane/src/notifications/notification-message.ts) owns the
fixed lock-screen text. On the phone, "Approvals and questions" gates Request alerts and "Replies
and updates" gates replies and failures.

The Account configures APNs (key id, team id, private key, topic) and FCM (service account)
independently; startup logs which are on. Registering a platform without its provider, or a Host
publication when neither is on, answers `push-not-configured`; withdrawing or listing registrations
never depends on a provider, so sign-out always reaches the Account. It intersects recipients with people who can still reach the Deployment and
turns each publication into one delivery per eligible device; `notification_publications` owns
idempotency, so a retried or repeated publication adds nothing. APNs collapse ids and Android
notification tags replace what a phone already shows, so an older alert that retries after a newer
one can replace it. Each iOS device is sent to the APNs origin its own entitlement names
(`development` → sandbox, `production` → production); one key serves both. A delivery that settles
failed or unregistered is logged without its token, and an unregistered token disables the device
until its next registration. The Account still accepts windows of up to a day
(`notificationExpiryMilliseconds`) and the `run-completed`, `run-interrupted` and
`report-published` kinds that older Hosts publish. Provider acceptance proves neither display nor
reading. See [notification-store.ts](../apps/control-plane/src/notifications/notification-store.ts)
for ingest and delivery fencing.

`thread.read.mark` advances a durable per-person marker monotonically to an actually published
message. The Host supplies viewer read state in Thread snapshots, pages and the ordered
subscription; the unread dot compares the eligible Message sequence with that marker. A background
subscription does not mark reading. Reply deep links carry the exact `messageId`; Request deep links
carry the `requestId`. On the phone a Request still waiting is docked in the composer, and the link
goes no further, even once it is answered; one already answered is found by its record, paging back
if it is older: in a task, at the turn holding it; in a conversation, in the Activity holding it,
opened at that reply's row when it has one.

Conversations do not draw an unread divider. While the reader looks through older messages, the
floating jump button counts published incoming messages that arrived since they last reached the
latest message. Own sends, streaming text and tool activity do not add to that count. The shared
`incomingTranscriptMessages` selector in `@opensteer/client/host` owns the rule for every client;
reaching the latest message clears the offer and marks only the content actually shown as read.

### Phone behavior

**Registration.** `apps/mobile/src/notifications/push-registration.ts` holds exactly one
registration, keyed by an installation id this install generated once and kept out of the deployment
catalog, which every directory sync rewrites. It registers the phone's raw provider token
(`getDevicePushTokenAsync`), never an Expo push token, and a build made without Android push
credentials refuses that token with a sentence Settings → Notifications repeats. Every sync — launch,
foreground, a rolled token, a preference or Account change — sends the registration, so a device
the Account disabled comes back the next time the app opens. Reading the token also announces it to
the token listener, so only a token this install has not sent yet starts another registration. A
refused registration keeps the last confirmed one, which sign-out still withdraws. On iOS it carries the
`aps-environment` the build was signed with, read from the embedded provisioning profile; a build
with none is production only when it is an App Store distribution, and otherwise registration
fails with a reason Settings shows rather than guessing. The registration shape became strict about
that field without a compatibility window, which is safe only because no deployed Account had push
configured before it, so no phone had ever registered; Accounts deploy before the phone that sends
it. The first message a person sends from the phone, while notification permission is still
undetermined, asks for it; Settings → Notifications asks too. Withdrawal is not part of the ordinary
sync: it has to happen while the Account credential still exists, so `signOut()` runs before that
credential is revoked.

**What a tap does.** The only payload field the app reads is `deepLink`
(`notifications/notification-routing.ts`); `deploymentId`, `threadId`, `requestId` and `kind` travel
beside it and are ignored rather than cross-checked, because a second source of truth about where to
go is a second thing that can disagree. The link goes through the one reader in
`packages/core/src/deep-links.ts`, the parser an operating-system deep link uses, so a notification
reaches exactly the Threads a typed URL could — and it is a destination, never an authority: the app
attaches, authenticates and reads current state before showing anything. An arrival for the Thread
already on screen is delivered silently and left in the list; a payload this app cannot read is
always presented, because suppressing it would hide it for no discoverable reason.

## 7. Building and running

**Dev client only.** The app uses `expo-dev-client` and native modules Expo Go does not carry;
there is no Expo Go path and none is wanted. `apps/mobile/README.md` is how to run it: the build
commands, mock mode, and every build-time variable with its meaning. Two facts about the machine
doing the build, because nothing in the repository can assert them:

- **`LANG` must name a UTF-8 locale** in the environment running the build (for example
  `LANG=en_US.UTF-8`); the native build tooling aborts without one.
- **`xcode-select`** must point at a full Xcode, not the Command Line Tools, before the iOS
  Simulator MCP tool can boot or drive a simulator.

**Bundle proof.** `pnpm --filter @opensteer/mobile exec expo export`, which
the affected merge gate runs for both platforms when mobile or its workspace inputs change, is the one command that
proves the graph actually resolves under Metro; the repo-level guards prove the graph is portable
and that the resolver keeps platform extensions, not that the bundler can build it. A simulator has
no push token, no radio and no cellular handover, so push, entitlements and network handover are
provable only on a physical device.

**Against a development Host.** The iOS Simulator shares the Mac's loopback, so a build with no
`EXPO_PUBLIC_OPENSTEER_ACCOUNT_ORIGIN` reaches `pnpm dev` at `http://localhost:43100` — that Host's
canonical origin, and a loopback origin `ConnectionOriginSchema` accepts over plain HTTP. The
development Web server is that origin and proxies discovery to the Host
(`apps/web/src/development/dev-server-boundary.ts`). Push needs an Account service; there is none
in this arrangement.

## Workspace compatibility

Expo shows a conversation's Tabs and the Deployment's Tabs, with one tile and one tab-targeted view
per tab. Session boundaries are internal; every client shows tabs and closes individual tabs. Shared
schemas accept optional reader-relative browser openers and owner-view version/list
metadata, including additive nested response fields. The shared client handles
`host.computer-view.changed` and `host.computer-view.removed` as owner metadata,
without advancing Workspace event cursors. Owner views never enter conversation surfaces
or automatic message context.

A conversation's Tabs route only task-session destinations (`surfaceRoute`). The sidebar's Tabs
routes a place's exact destination (`workspaceRoute`), owner views by view ID and generation; it
never turns a view ID into a task session or the reverse. Expo retains an owner view only while it
is shown; it has no owner-view opener, local activation, recents or desktop reflow UI. Saved tabs
restore through the shared activation owner; an older Host without durable tabs lists live tabs
through `placeList`'s live-session path.
Owner notices and native H.264 phone viewing require a matching client binary; the normal
epoch mismatch flow applies in both directions. Phone tiles and full views use the shared
display transport and the local PhoneDisplay module. Mac task app views use that same H.264
transport and native decoder, with exact session/app authority and no phone input controls.

Mac window sharing uses two native sessions per helper, at most one warm for a non-sliding
30 seconds under existing authority. Evicting a warm media stream preserves a valid owner
lease. Target/source or transport replacement advances the native decoder epoch and clears
queued output and displayed pixels before the new target appears, including Watch resolving
a different window under the same task source. Same-source recovery can retain its picture;
static age is never a failure signal. Suspended capture clears the picture until tracked
lifecycle permits restoration; owner exit and terminal errors end the assignment. Semantic
composition updates retain the exact root/process and follow the shared
[window-group rules](computer-use.md#2-the-helper). Each owner app view binds its own
window; task Watch follows the agent's current window and never substitutes an owner
view. OS sharing controls are accepted; hidden/off-Space roots capture alone. One pending
target may await warm teardown within
the original 30-second startup budget. Mac window video is disabled on iOS in this release
until native decode and suppression/background-return qualification passes. Android retains
the shared native decoder path; exports alone do not establish native playback.

The selected attachment supplies a capability reader to the shared Host client.
Initial bootstrap and periodic refresh reuse discovery verified for that attachment only.
Reconnects, explicit refresh and epoch or authentication refusals reverify through the same
identity and attachment-generation checks, so a Host upgrade at the same route is observed. When the
agreement changes, retained browser viewers resubscribe with the new capture
agreement, including viewers that reconnected before discovery finished.

A definitive identity or epoch refusal revokes the still-current attachment through
MobileClient: it disposes the Host client, closes its sockets and fences retained
HTTP/socket authorization, including pending credential reads. Selection and the
repair verdict remain visible. Reattachment verifies again before credentials may
flow. Unreachable discovery preserves the attachment, and a late result cannot
revoke a newer selection, route or attachment.

### Saved-view deletion

Saved views have one deletion owner shared by credential lifecycle and presentation.
Before deleting a Deployment's encryption key, it exclusively creates an empty
`.deny` file in the app's private document storage, independent of SecureStore and
the evictable ciphertext cache. A marker always means a cache miss and a deletion
retry, including after restart. Only successful key deletion permits removing it.
Memory hides refused content immediately and fences pending reads and writes.
If marker creation fails, key erasure is still attempted, memory remains blocked,
and cleanup reports failure and retries the marker on foreground. Content can
resurface after restart only if both the private-file marker write and the secure
key deletion fail and the app is terminated before a retry succeeds.
