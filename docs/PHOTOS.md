# Adding your photos to Apple Photos.app

On a Mac, Care Album Saver can also add the photos it saves to Apple Photos.app, the Photos
app that comes with every Mac. It is **off unless you turn it on**, and this page explains
what it does before you decide.

Your photos are saved in your own folder either way. This puts a copy of each one in
Apple Photos.app as well.

## What it means for your privacy

Everywhere else, this tool can promise that nothing it saves leaves your computer. This is
the one setting that changes that, so it is worth being plain about:

- **If iCloud Photos is on, Apple Photos.app uploads them to your iCloud account**, and from
  there to your iPhone, your iPad and anything else signed in to the same Apple Account. That
  upload is done by Apple Photos.app, not by this tool, and it counts against your iCloud
  storage.
- **If you share a library with family** through iCloud Shared Photo Library, the people you
  share it with may see them too, depending on how Apple Photos.app is set up to share new
  items.
- **If iCloud Photos is off**, they stay in the Photos library on this Mac.

Nothing else changes. The tool still has no website, no account and no server of its own,
and it still sends nothing about you anywhere.

## What goes in

**Every photo and video saved so far, for every child, and then each run's new ones.** Each
one goes in once. The tool keeps a list of everything it has handed to Apple Photos.app, by
each file's contents (its SHA-256 fingerprint), so a file is not handed over twice, even after
a change of folder layout moves it. Two exceptions: a picture the nursery posted twice is two
files in your folder, each with its own date, and each goes in; and a batch cut off part-way
— Apple Photos.app stopped answering in the middle of it — is handed over again, and may then
appear twice.

What it cannot know is what you put into Apple Photos.app yourself: finding that out would
mean reading your library, and it never does. Any photo you already added by hand would
appear twice.

## What you will see in Apple Photos.app

A folder called **Brightwheel**, holding the same folders and albums as your archive folder
on disk. Which shape that is depends on the folder layout you chose in step 2:

| Folder layout | In Apple Photos.app |
|---|---|
| Each child, then a folder per week (the default) | Brightwheel › Robin-Maple › **2026-W38** |
| One folder per week, all children together | Brightwheel › **2026-W38** |
| Each week, then a folder per child | Brightwheel › 2026-W38 › **Robin-Maple** |

The last name in each row is an album; the others are folders. Apple Photos.app can only keep
pictures in albums and albums in folders, so that is how a folder of photos on disk has to be
spelled there. If you change the layout later, new photos go into the new shape and the old
albums stay as they are.

## Turning it on

1. **First, in Apple Photos.app,** open **Settings › General** (**Preferences › General** on
   macOS 12 and earlier) and check that **Copy items to the Photos library** is ticked. It
   comes ticked, and it must stay ticked while this is on: if it is off, the photos this tool
   adds will not open and will never reach iCloud.
   [Why](#two-apple-photosapp-settings-worth-knowing-about).
2. Open the setup page, press **Settings and Maintenance** at the top right, and choose
   **Integrations**.
3. Under **Also add them to Apple Photos.app**, tick **Add them to Apple Photos.app**.
4. The page asks two things at once: whether that setting is ticked, and whether all the
   photos saved so far — it says how many — should go in. Choose **OK** if both are yes. If
   you choose **Cancel**, nothing is turned on and nothing changes.
5. Your Mac asks whether to let the program control Apple Photos.app. It says something like
   *"Terminal" wants access to control "Photos"*. Choose **OK**.

Your Mac's question is asked when you tick the box, deliberately, so that it appears while you
are there to answer it. If you choose **Don't Allow**, the box stays unticked and the page says
how to change your mind.

**Nothing goes in the moment you tick the box.** The next run adds them, the daily one
included, or press **Add them to Apple Photos.app now** under the box. That button adds what
is waiting and fetches nothing from Brightwheel. It then says how many Apple Photos.app
imported: that number is Apple Photos.app's own, the count its import gives back, not the
number the tool handed over. If the two differ, the page says so. A large archive takes a
while; you can close the page, and the import carries on in the window you started the tool
from.

### If you turned it on with an earlier version

Versions before 24 September 2026 added only the photos saved after you turned the option on.
If you turned it on then, that still holds after you update: nothing saved earlier goes to
Apple Photos.app, or to iCloud, without your say-so. The page says how many saved earlier are
not being added. To add every photo, untick the box and tick it again; the page asks first.

### The daily run asks separately

If you have set up the daily run, it starts the tool as a different program from the one you
opened the setup page in, and macOS keeps a separate permission for each program. So the
first evening it adds photos, your Mac may ask again — this time naming `node` or
`osascript`. Choose **OK** and it will not ask again.

If nobody is there to answer, nothing is lost. The photos are in your folder, they wait on the
tool's list, and the next run adds them. The page shows that the last attempt did not work,
and your Mac shows one notification the first time it happens (not every evening after).

## Turning it off

Untick the box. Nothing more is added to Apple Photos.app: an import going at that moment,
a run's included, stops once Apple Photos.app has the batch it is taking. Everything already
there stays, and so does everything in your folder.

To take them out of Apple Photos.app as well, open each album in the **Brightwheel** folder,
select the photos and press **Command-Delete**. Pressing Delete on its own only takes them out
of the album and leaves them in your library, and deleting an album removes the album but
leaves its photos in your library too. Deleted photos sit in **Recently Deleted** for 30 days,
and with iCloud Photos on they are removed from your other devices as well.

## Two Apple Photos.app settings worth knowing about

**Copy items to the Photos library** (in Apple Photos.app's **Settings › General**, on the
line headed *Importing*). **It must be on**, which is how Apple Photos.app comes. With it on,
each photo is copied into the Photos library. With it off, Apple Photos.app only points at the
file it was given instead of keeping a copy — and this tool gives it a temporary copy of each
photo, not the file in your folder (see [How it works](#how-it-works)), and deletes that copy
once Apple Photos.app has it. Those photos would still show a small preview in the album, but
would not open, and since files kept outside the library are not stored in iCloud
([Apple's own documentation](https://support.apple.com/guide/photos/change-where-photos-and-videos-are-stored-pht1ed9b966d/mac);
Apple Photos.app says under the box that *"Only items copied to the library will upload to
iCloud Photos"*), they would never reach your other devices either. The tool would also have
written them down as added, so it would not offer them again.

Apple Photos.app gives no way for this tool to see the setting, so it cannot check for you.
That is why the setup page says so above the switch and asks you to confirm it every time you
turn the option on. If it was off when photos were added, see
[If photos in the Brightwheel folder will not open](#if-photos-in-the-brightwheel-folder-will-not-open).

The setting covers every import in Apple Photos.app, not only this tool's. If you keep it off
on purpose, because your library refers to files kept elsewhere, this option is not for you:
leave it off.

**Storage.** With copying on, each photo takes space twice on this Mac: once in your folder
and once in the Photos library. With iCloud Photos on, **Optimize Mac Storage** (in Apple
Photos.app's **Settings › iCloud**) lets it keep smaller versions on the Mac and the originals
in iCloud.

## How it works

Everything this tool ever asks Apple Photos.app to do is in one short AppleScript, which you
can read before you turn anything on:

**[`packages/care-album-saver/applescript/add-to-photos.applescript`](https://github.com/ip2k/care-album-saver/blob/main/packages/care-album-saver/applescript/add-to-photos.applescript)**

After a run, or when you press **Add them to Apple Photos.app now**, the tool works out which
saved files have not been handed over yet, groups them by album, and runs the script once per
album, up to fifty files at a time:

```sh
/usr/bin/osascript add-to-photos.applescript Brightwheel Robin-Maple 2026-W38 -- /private/copy/one.jpg /private/copy/two.mp4
```

Before anything else, the script checks that the Photos app it is about to talk to is
**Apple's own**, the one in `/System/Applications`, which nothing can change while System
Integrity Protection is on. Another app can call itself "Photos", or claim Apple Photos.app's
identifier; if the Photos app your Mac would open is not Apple's, or any program running as
Photos is not, the script stops and nothing is added. Asking macOS where Apple Photos.app is
does not open it.

Then it finds each folder and the album, makes any that are missing, imports the files into
the album, and prints how many Apple Photos.app took. When it works, that one number is all
that comes back from Apple Photos.app: no names, no paths, nothing from your library. When it
fails, the page shows the last line of the error it reported. The script never
deletes, moves, renames or edits anything already in Apple Photos.app, and it reads nothing
from your library except those folders and that album, looked up by name.

A few decisions in it are worth explaining:

- **Apple Photos.app gets private copies, and only of photos this tool saved.** It is never
  handed the files in your photos folder. Each one is copied into a folder that, of the
  ordinary accounts on the Mac, only yours can open; an administrator can open anything. On a
  Mac's own disk the copy is a clone and takes no extra space. The copy's fingerprint
  (SHA-256) is checked against the record this tool keeps of every photo it saved, and only a
  copy that matches goes to Apple Photos.app; the copies are deleted once it has them, which
  is why its **Copy items to the Photos library** setting must stay on. That record,
  `fingerprints.json`, lives beside your settings rather than in the photos folder, so nothing
  else that can change that folder — another computer it syncs with, say — can choose what goes
  into Apple Photos.app. A photo that has been changed, or put there by something else, is left
  out and named on the page, so you can look at it. Photos saved by an earlier version of this
  tool, before it kept that record, are taken as they are on disk, once, the first time it runs.
- **Names and files are arguments, never part of the script.** Each one reaches the script as
  a separate piece of data, so a file named `"; do shell script …` is an odd file name and
  nothing more. No shell is involved at any point.
- **Apple Photos.app's duplicate check is turned off**, because with it on Apple Photos.app
  stops at every duplicate and waits for someone to click a button, which nobody is there to
  do at seven in the evening. Instead the tool keeps its own list of every file it has handed
  over — by content fingerprint (SHA-256), so a photo moved by a change of layout, or posted
  twice, is still recognised — and does not hand the same file over twice, unless a batch was
  cut off part-way (see below).
- **The list is only updated after Apple Photos.app accepts a batch.** If it refuses or does
  not answer, that batch and everything after it stays waiting for the next run. If it accepts
  a batch but counts fewer than it was given, the whole batch is still written down, because
  it does not say which ones, and handing them all over again would add a second copy of each
  one it did take. The page tells you how many it did not confirm; they are in your folder.
- **One import at a time.** If the daily run and a press of the button happen together, the
  second one leaves Apple Photos.app to the first.

The list lives beside your settings, in `photos.json` in the folder that
`care-album-saver where` prints. **Do not delete it while the option is on.** It is the only
record of what Apple Photos.app already has, so without it the next run would hand over every
photo in your archive again — including what it already has, as duplicates.

When the setting is turned on, the setup page runs the same script with nothing to add, and
all it does then is count your albums. That is the harmless question that makes macOS ask
for permission while you are watching.

## When something goes wrong

The page says what happened under **Also add them to Apple Photos.app**, and the daily run's
log (**View the log** on the main page) has a `PHOTOS` line whenever the daily run adds
photos or cannot.

| What it says | What to do |
|---|---|
| *Your Mac has not allowed Care Album Saver to add photos to Apple Photos.app* | Open **System Settings › Privacy & Security › Automation**. Find the program listed there — Terminal, or `node` for the daily run — and turn on **Photos** under it. |
| *Apple Photos.app did not answer in time* | Open Apple Photos.app yourself once and check it shows your library rather than a welcome screen or a question. Then press **Add them to Apple Photos.app now**. If it stopped answering part-way through, some of that batch may be in Apple Photos.app already and will be handed over again: look for doubles in that week's album. |
| *Apple Photos.app could not be opened on this Mac* | Check Apple Photos.app opens normally from your Applications folder. |
| *Another run is adding photos to Apple Photos.app right now* | Nothing to do; the other run is doing it. |
| *…not a file this tool saved on this Mac, or not as it saved it* | Something changed those photos, or put them in your folder, after this tool saved its own. If it was you (an edit, say), add them to Apple Photos.app by hand. If not, look at them before you do. |
| *Nothing was added to Apple Photos.app: the Photos this Mac would open is at …* | Another app has taken the name or identity of Apple Photos.app. Find it (the message says where it is), and remove it if you do not know what it is. |
| *Apple Photos.app did not confirm … of the photos it was given* | It took the batch but counted fewer than it was given, or gave no count. Every photo is still in your folder; if one is missing from Apple Photos.app, add it from there by hand. |

In each case in the table your photos are safe in your folder, and the ones that were not
added wait for the next run — except those Apple Photos.app did not confirm, which were
written down as added with the rest of their batch.

### If photos in the Brightwheel folder will not open

The page cannot see this one. Apple Photos.app still shows a small preview of each, but opening
one says **Missing File**: *"Photos with unavailable original files cannot be opened."* That
means **Copy items to the Photos library** was off when they were added. To put it right:

1. Tick **Copy items to the Photos library** (Apple Photos.app, **Settings › General**).
2. In the album, select the photos that will not open and press **Command-Delete**. Pressing
   Delete on its own only takes them out of the album and leaves them in your library.
3. Add them again from your own folder, where every one still is: drag the photos from that
   week's folder in the Finder onto the same album in Apple Photos.app. (**File › Import**
   works too, but choose the album in its **Album** menu, or they go only into **Imports**.)

If Apple Photos.app offers **Find Original…**, do not use it to point at the photo in your own
folder. The photo would open again, but Apple Photos.app would still keep only a link to your
folder, not a copy of its own: it would still not reach iCloud, and it would go missing again
if that folder were ever moved. This tool will not add them again by itself, because it wrote
them down as added.

## Shared albums and a Shared Library

The script works only inside the **Brightwheel** folder it makes at the top of your library,
and folders cannot be shared in Apple Photos.app, so it cannot add anything to a shared album.
If you use an **iCloud Shared Library**, whether new imports land in your personal library or
the shared one is Apple Photos.app's own setting; the script does not choose. Check it before
turning this on if you share a library with anyone.

## Not on Windows or Linux

The option only appears on a Mac, because it is Apple Photos.app it talks to. There is no
equivalent here for Google Photos or anything else; if you use another photo service, its own
desktop app can usually be pointed at your archive folder.
