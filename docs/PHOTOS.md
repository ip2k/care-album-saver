# Adding your photos to Apple Photos

On a Mac, Care Album Saver can also add each run's new photos to the Photos app. It is
**off unless you turn it on**, and this page explains what it does before you decide.

Your photos are saved in your own folder either way. This puts a copy of each new one in
Photos as well.

## What it means for your privacy

Everywhere else, this tool can promise that nothing it saves leaves your computer. This is
the one setting that changes that, so it is worth being plain about:

- **If iCloud Photos is on, Photos uploads them to your iCloud account**, and from there to
  your iPhone, your iPad and anything else signed in to the same Apple Account. That upload
  is done by Apple's Photos, not by this tool, and it counts against your iCloud storage.
- **If you share a library with family** through iCloud Shared Photo Library, the people you
  share it with may see them too, depending on how Photos is set up to share new items.
- **If iCloud Photos is off**, they stay in the Photos library on this Mac.

Nothing else changes. The tool still has no website, no account and no server of its own,
and it still sends nothing about you anywhere.

## What you will see in Photos

A folder called **Brightwheel**, holding the same folders and albums as your archive folder
on disk. Which shape that is depends on the folder layout you chose in step 2:

| Folder layout | In Photos |
|---|---|
| Each child, then a folder per week (the default) | Brightwheel › Robin-Maple › **2026-W38** |
| One folder per week, all children together | Brightwheel › **2026-W38** |
| Each week, then a folder per child | Brightwheel › 2026-W38 › **Robin-Maple** |

The last name in each row is an album; the others are folders. Photos can only keep pictures
in albums and albums in folders, so that is how a folder of photos on disk has to be spelled
there. If you change the layout later, new photos go into the new shape and the old albums
stay as they are.

## Turning it on

1. Open the setup page and press **Settings and Maintenance** at the top right.
2. Under **Also add them to Apple Photos**, tick **Add new photos to the Photos app after each run**.
3. Your Mac asks whether to let the program control Photos. It says something like
   *"Terminal" wants access to control "Photos"*. Choose **OK**.

That question is asked when you tick the box, deliberately, so that it appears while you are
there to answer it. If you choose **Don't Allow**, the box stays unticked and the page says
how to change your mind.

**It covers photos saved from then on.** The ones already in your folder are not added unless
you ask: the page offers **Add the ones saved before you turned this on**, and asks you to
confirm, because you may already have put some of them into Photos yourself — and those
would then appear twice.

### The daily run asks separately

If you have set up the daily run, it starts the tool as a different program from the one you
opened the setup page in, and macOS keeps a separate permission for each program. So the
first evening it adds photos, your Mac may ask again — this time naming `node` or
`osascript`. Choose **OK** and it will not ask again.

If nobody is there to answer, nothing is lost. The photos are in your folder, they wait on the
tool's list, and the next run adds them. The page shows that the last attempt did not work,
and your Mac shows one notification the first time it happens (not every evening after).

## Turning it off

Untick the box. Nothing more is added to Photos; everything already there stays, and so does
everything in your folder.

To take them out of Photos as well, open the **Brightwheel** folder in Photos, select the
photos and delete them. Deleting an album on its own removes the album but leaves the photos
in your library. Deleted photos sit in **Recently Deleted** for 30 days, and with iCloud
Photos on they are removed from your other devices too.

## Two Photos settings worth knowing about

**Copy items to the Photos library** (Photos › Settings › General › Importing). With this on,
which is how Photos comes, each photo is copied into the Photos library. With it off, Photos
only points at the file in your archive folder — and
[Apple's own documentation](https://support.apple.com/guide/photos/change-where-photos-and-videos-are-stored-pht1ed9b966d/mac)
says files kept outside the library are not stored in iCloud and will not reach your other
devices. They also go missing in Photos if you move or rename the archive folder.

**Storage.** With copying on, each photo takes space twice on this Mac: once in your folder
and once in the Photos library. With iCloud Photos on, **Optimize Mac Storage** (Photos ›
Settings › iCloud) lets Photos keep smaller versions on the Mac and the originals in iCloud.

## How it works

Everything this tool ever asks Photos to do is in one short AppleScript, which you can read
before you turn anything on:

**[`packages/care-album-saver/applescript/add-to-photos.applescript`](https://github.com/ip2k/care-album-saver/blob/main/packages/care-album-saver/applescript/add-to-photos.applescript)**

After a run, the tool works out which saved files have not been handed to Photos yet, groups
them by album, and runs the script once per album, up to fifty files at a time:

```sh
osascript add-to-photos.applescript Brightwheel Robin-Maple 2026-W38 -- /path/one.jpg /path/two.mp4
```

The script finds each folder and the album, makes any that are missing, imports the files
into the album, and prints how many Photos took. It never deletes, moves, renames or edits
anything already in Photos, and it reads nothing from your library except those folders and
that album, looked up by name.

A few decisions in it are worth explaining:

- **Names and files are arguments, never part of the script.** Each one reaches the script as
  a separate piece of data, so a file named `"; do shell script …` is an odd file name and
  nothing more. No shell is involved at any point.
- **Photos' duplicate check is turned off**, because with it on Photos stops at every
  duplicate and waits for someone to click a button, which nobody is there to do at seven in
  the evening. Instead the tool keeps its own list of every file it has handed over — by
  content fingerprint (SHA-256), so a photo moved by a change of layout, or posted twice, is
  still recognised — and never hands the same file over twice.
- **The list is only updated after Photos accepts a batch.** If Photos refuses or does not
  answer, that batch and everything after it stays waiting for the next run.
- **One run at a time.** If the daily run and a press of the button happen together, the
  second one leaves Photos to the first.

The list lives beside your settings, in `photos.json` in the folder that
`care-album-saver where` prints. **Do not delete it while the option is on.** It is the only
record of what Photos already has, so without it the next run would hand Photos everything
saved since you turned the option on — including what it already has, as duplicates.

When the setting is turned on, the setup page runs the same script with nothing to add, and
all it does then is count your albums. That is the harmless question that makes macOS ask
for permission while you are watching.

## When something goes wrong

The page says what happened under **Also add them to Apple Photos**, and the daily run's log
(**View the log** on the main page) has a `PHOTOS` line whenever the daily run adds
photos or cannot.

| What it says | What to do |
|---|---|
| *Your Mac has not allowed Care Album Saver to add photos to Photos* | Open **System Settings › Privacy & Security › Automation**. Find the program listed there — Terminal, or `node` for the daily run — and turn on **Photos** under it. |
| *Photos did not answer in time* | Open Photos yourself once and check it shows your library rather than a welcome screen or a question. Then press **Save new photos**. |
| *Photos could not be opened on this Mac* | Check Photos opens normally from your Applications folder. |
| *Another run is adding photos to Photos right now* | Nothing to do; the other run is doing it. |

In every case your photos are safe in your folder, and the ones that were not added wait for
the next run.

## Not on Windows or Linux

The option only appears on a Mac, because it is Apple's Photos app it talks to. There is no
equivalent here for Google Photos or anything else; if you use another photo service, its own
desktop app can usually be pointed at your archive folder.
