# Care Album Saver

**Save your own child's photos from Brightwheel onto your own computer, sorted into a folder for each week.**

<!-- Every one of these is tested on each change: the whole suite runs on all three systems, against
     Node 22, 24 and 26 (.github/workflows/ci.yml). The first badge is the live result; if any of
     them breaks, it turns red. -->
<p align="center">
  <a href="https://github.com/ip2k/care-album-saver/actions/workflows/ci.yml"><img alt="Tests: the latest result on every system" src="https://github.com/ip2k/care-album-saver/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/ip2k/care-album-saver/actions/workflows/ci.yml"><img alt="Tested on macOS" src="https://img.shields.io/badge/macOS-tested-8E8E93?logo=apple&amp;logoColor=white"></a>
  <a href="https://github.com/ip2k/care-album-saver/actions/workflows/ci.yml"><img alt="Tested on Windows" src="https://img.shields.io/badge/Windows-tested-0078D4?logo=data:image/svg%2bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHJlY3QgeD0iMi41IiB5PSI0IiB3aWR0aD0iMTkiIGhlaWdodD0iMTYiIHJ4PSIyIiBmaWxsPSJub25lIiBzdHJva2U9IiNmZmYiIHN0cm9rZS13aWR0aD0iMiIvPjxwYXRoIGQ9Ik0yLjUgOWgxOSIgc3Ryb2tlPSIjZmZmIiBzdHJva2Utd2lkdGg9IjIiLz48L3N2Zz4="></a>
  <a href="https://github.com/ip2k/care-album-saver/actions/workflows/ci.yml"><img alt="Tested on Ubuntu" src="https://img.shields.io/badge/Ubuntu-tested-E95420?logo=ubuntu&amp;logoColor=white"></a>
  <a href="https://github.com/ip2k/care-album-saver/actions/workflows/ci.yml"><img alt="Node.js 22, 24 or 26" src="https://img.shields.io/badge/Node.js-22%20%7C%2024%20%7C%2026-5FA04E?logo=nodedotjs&amp;logoColor=white"></a>
  <a href="LICENSE"><img alt="MIT licence" src="https://img.shields.io/badge/licence-MIT-blue"></a>
</p>

<p align="center">
  <img src="docs/images/00-dashboard.png" alt="The Care Album Saver page in a web browser. Under the heading Your archive it says 28 photos and videos were saved, then shows a grid of twenty-four colourful thumbnails, each labelled with the date it was posted, with buttons to save new photos, open the folder and view the log underneath." width="800">
</p>
<p align="center"><sub>What you see once your photos are saved: the latest ones at a glance, and one button to fetch anything new. The children and photos here are invented for the demo.</sub></p>

Your nursery posts photos of your child to Brightwheel, and there they stay: on
Brightwheel's servers, saved one at a time from the website, and reachable only for as long
as your family's access to that profile lasts. When a child leaves, so does the album.

This tool copies all of them onto your own computer, into a folder for each week. The files
arrive carrying nothing — no date, no name, nothing a photo app can sort by — so it writes
in the time each one was posted, your child's name and the teacher's note, and leaves a
plain-text `.json` beside every file so the archive still reads in twenty years without
this tool. Run it once a day and it only fetches what is new.

What you end up with is yours, on your disk, and it outlives the account.

## Contents

1. [What you end up with](#what-you-end-up-with)
2. [Is it safe? Privacy and security](#is-it-safe-privacy-and-security)
   — [where the photos go](#where-do-my-childs-photos-go),
   [who can see them](#can-anyone-else-see-them),
   [your password](#what-about-my-password),
   [what it cannot protect you from](#what-this-tool-cannot-protect-you-from)
3. [Before you use this: Brightwheel's terms](#before-you-use-this-brightwheels-terms)
4. [Getting started](#getting-started)
5. [Everyday use](#everyday-use)
   — [every day, automatically](#running-it-every-day),
   [stopping and carrying on](#stopping-a-run-and-carrying-on),
   [Apple Photos](#adding-them-to-apple-photos-mac-optional),
   [keeping it up to date](#keeping-it-up-to-date)
6. [What gets written into each photo and video](#what-gets-written-into-each-photo-and-video)
   — [about the dates, honestly](#about-the-dates-honestly)
7. [Advanced and technical](#advanced-and-technical)
   — [commands and options](#commands-and-options),
   [Docker](#running-it-in-docker),
   [how it works](#how-it-works),
   [for people who fork this project](#for-people-who-fork-this-project),
   [how the code is laid out](#how-the-code-is-laid-out),
   [development](#development)
8. [Licence](#licence)

---

## What you end up with

A folder on your computer with, by default, a folder inside it for each child and, inside
that, one for each week (two other layouts are a setting away):

```
Care Album Photos/
├── archive.json           ← the tool's list of what it has already saved
├── Robin-Maple/
│   ├── 2026-W37/          ← 7–13 September 2026
│   │   ├── 2026-09-09_084512_a1b2c3d4.jpg
│   │   ├── 2026-09-09_084512_a1b2c3d4.jpg.json
│   │   └── README.md
│   └── 2026-W38/
└── Sam-Maple/
```

Each photo's name starts with the date it was posted, so the files sort in order anywhere.
The small `.json` file beside each one is plain text that any computer can open. [What goes
into each file](#what-gets-written-into-each-photo-and-video) is further down.

---

## Is it safe? Privacy and security

**This is the most important section in this file. It is written for everyone, not just
for programmers.**

### Where do my child's photos go?

Two places, and only two places:

1. **Brightwheel's service**, where they already are.
2. **The computer you run this on**, in the folder you choose.

That's it, unless you add a third yourself. There is no website to sign up to, no online
account, and no company behind it. This tool uploads nothing anywhere. Nobody — including the
people who wrote this — can see your photos, your child's name, or which nursery they go to.

The one way to add a third place is a setting that is **off unless you turn it on**: on a Mac,
the tool can also add new photos to the Photos app, and if you use iCloud Photos, Apple then
uploads them to your iCloud account. [What that setting does, and how](docs/PHOTOS.md).

The setup page can also ask GitHub, once a day, whether there is a newer version of this
tool — only if you say yes when it asks. That request carries nothing about you, your account
or your children. [What it sends](docs/UPDATING.md#finding-out-that-there-is-a-new-version).

One honest clarification, because the word matters: the setup page *does* run a small web
server, but it runs **on your own computer**, only while the program is open, and only your
computer can reach it. It is not on the internet.

### Can anyone else see them?

| | |
|---|---|
| **Does this tool send my photos anywhere?** | No. They go from Brightwheel straight to your computer. |
| **Does it collect usage data or analytics?** | No. It talks to Brightwheel's API and to the photo links Brightwheel hands back. The only other place it ever contacts is GitHub, and only if you said yes to checking for new versions: then the setup page asks GitHub which version is the newest, at most once a day and only while the page is open, and sends nothing about you, your account or your children. [How that check works](docs/UPDATE-CHECK.md). |
| **Can the authors see anything?** | No. Nothing is sent to us; there is no service to send it to. |
| **Can other parents see my child's photos?** | No. Brightwheel only ever shows this tool the children on *your* account. |
| **Can I archive someone else's child?** | No. This is not a limitation we added — it is how Brightwheel works. Your login only reaches your own family. |

### What about my password?

**This tool never asks for and never sees your Brightwheel password.** There is no box for
it anywhere — not on the setup page, not in the terminal, not behind an option you could
turn on by mistake.

You sign in on Brightwheel's own website, exactly as you always do, including the
6-digit code they text or email you. Then you copy one value — a "session", which is
like a temporary ticket that says "this person is already signed in" — and paste it in.

That session is stored **on your computer only**, in your private settings folder, in a
file only your user account can open — on a Mac or Linux, and apart from anyone who is an
administrator of the computer; on Windows the protection is weaker
([what this tool cannot protect you from](#what-this-tool-cannot-protect-you-from)). It is
never sent anywhere except back to Brightwheel.

Copying that value out of your browser is fiddlier than typing a password would be, and
that is a trade we made on purpose: getting into the habit of typing your real password
into other people's software is a bad habit to build, even when the software is honest.
[Why there is no password sign-in, and why there will not be one](docs/DECISIONS.md#a1-the-only-sign-in-is-a-pasted-session).

### The setup page that opens in your browser

When you run the setup assistant, it prints a link starting `127.0.0.1` for you to paste into your browser. That
number means **this computer and nothing else**. The page is not on the internet. Nobody
on your wifi, in your building, or anywhere in the world can open it. It closes when you
stop the program.

### What this tool cannot protect you from

Honesty matters more here than reassurance, so:

- **If someone can use your computer, they can see the photos.** They are ordinary files
  in an ordinary folder. Use a password on your computer.
- **If you save into a cloud-synced folder** — iCloud Drive, Dropbox, OneDrive, Google
  Drive — then that service will copy every photo to their servers. On a Mac, Desktop and
  Documents are often synced to iCloud without you turning it on. The default location
  (`~/Care Album Photos`) avoids this, but if you change it, check where you are pointing.
- **Photos may contain other children.** A group photo from your child's class has other
  families' children in it. Please treat those photos the way you would want yours treated.
- **Labelling photos with names writes those names into the file itself.** Your child's
  name, the nursery's name, the name of whoever posted the photo, and the teacher's note —
  which usually names all three in one sentence. That is what makes them searchable in
  Apple Photos and similar apps, but it also means those names travel with the file if you
  ever share it. You can turn this off with one switch, and then nothing inside the file
  says who or where. Everything is still recorded in the small `.json` file beside each
  photo, which stays behind when you share the photo itself.
- **Removing location information needs ExifTool.** If you have not installed it, every
  photo is still saved and everything is still written to the `.json` file beside it — but
  nothing can be changed inside the photo, so any coordinates it arrived with are still
  there. The run says so rather than leaving you to assume otherwise.
- **On Windows, the files are not owner-only.** On a Mac or Linux this tool writes the
  session file so that only your account can open it, and creates the photo folders the
  same way. Windows has no equivalent file setting: the session and the photos inherit the
  permissions of the folder they are in. For `%APPDATA%` that already keeps other standard
  accounts on the PC out, but it is weaker than what a Mac or Linux gets, and it is not
  something this tool can fix.
- **An administrator can open anything.** "Only your account can open it" means other
  ordinary accounts. Anyone who is an administrator of the computer — on a Mac, Linux or
  Windows alike — can open every file on it, the session and the photos included.

If you are a developer, the technical side of all this is in [SECURITY.md](SECURITY.md), and
[For people who fork this project](#for-people-who-fork-this-project) is further down.

---

## Before you use this: Brightwheel's terms

**Please read this part properly. We are not going to pretend the question does not exist.**

Brightwheel's [Terms of Service](https://mybrightwheel.com/terms/) restrict automated
access to their service. They prohibit anyone who *"Crawls, scrapes, or spiders any page,
data, or portion of or relating to the Services or Content"* and who *"Copies or stores the
Content or any portion thereof."* This tool does automated access, and it does store
content.

We make **no claim** that using it is permitted. That is between you and Brightwheel.
Please read their terms yourself and decide. Use this at your own risk.

What we can tell you plainly:

- It only ever reads **your own account** — the photos of your own children.
- It only **reads**. It never changes or deletes anything in your Brightwheel account.
- It is deliberately gentle: one request at a time, with a pause between them. That is a
  lighter load than scrolling the website yourself.

We also want to correct something you may read elsewhere. Tools like this are sometimes
justified by data-protection "portability" rights. **That argument does not hold here.**
Brightwheel's privacy policy treats your child's photos as Customer Data that it processes
*on behalf of the school*. That makes the school the data controller and Brightwheel the
processor — and portability rights run against the controller. If you want a formal copy of
your child's data, ask the school.

> **Not affiliated with or endorsed by Brightwheel.** This is an independent tool, provided
> as-is with no warranty. Field names in an undocumented API can change without warning; if
> that happens the tool stops with a clear message rather than silently saving nothing.

---

## Getting started

The setup assistant walks you through everything. **[Full illustrated guide →](docs/GUIDE.md)**

**This is not on npm yet**, so it is built from a clone. That is five commands, once:

```sh
git clone https://github.com/ip2k/care-album-saver.git
cd care-album-saver
pnpm install
pnpm build
node packages/care-album-saver/dist/cli.js setup
```

`pnpm install` needs [pnpm](https://pnpm.io/installation) and Node 22 or newer. Everything
after the first run is just the last line again. If you would rather type
`care-album-saver` than the whole path, run `pnpm link --global` inside
`packages/care-album-saver` once.

Then open the link it prints. Three steps: connect your account, tick the children you want
and check the settings, then press **Start saving** — and optionally set up a daily run
(step 4). Each setting saves itself the moment you change it, so there is nothing to
remember to press, and while a run is going there is a **Stop** button beside
**Start saving**.

<p align="center">
  <img src="docs/images/01-connect.png" alt="The setup assistant, showing how to find your Brightwheel session" width="780">
</p>

Once you have connected once, you never need to again until the session expires:

```sh
care-album-saver run        # save any new photos
```

---

## Everyday use

### Running it every day

The tool sets this up itself. On the setup page it is step 4, **Save new photos every
day**; from the terminal it is:

```sh
care-album-saver schedule on --at 19:00   # every evening at seven
care-album-saver schedule                 # is it set up, and how did the last run go?
care-album-saver schedule off             # stop
```

It hands the job to the scheduler your computer already has — launchd on a Mac, a systemd
timer on Linux (or a crontab line where there is no systemd), Task Scheduler on Windows —
and writes in the full paths to Node and to this tool, so there is no crontab line to write
by hand and nothing for the scheduler to go looking for.
[The guide has the details](docs/GUIDE.md#doing-it-automatically-every-day).

A computer has one daily run, and it belongs to the copy of the tool that set it up. If you
have two copies, the second one leaves it alone unless you say otherwise: the setup page asks
whether to move it, and the terminal needs `schedule on --replace`.

If you would rather run it in Docker, see [Running it in Docker](#running-it-in-docker).

### Stopping a run, and carrying on

Press `Ctrl` + `C` while a run is going. It finishes the photo it is saving, writes down
everything it has saved so far, and stops. The summary line then begins **Stopped.** rather
than **Done.** — for example `Stopped. 12 new, 40 already had, 0 failed.` — followed by a
line telling you to run the same command again to carry on where it left off.

Press `Ctrl` + `C` a second time and it exits on the spot. That is the harsher option:
nothing is written down, so the photo in flight is abandoned and up to a couple of dozen
files saved since the last checkpoint are fetched again next time, leaving you a second
copy of each, named `…-2.jpg`. The first `Ctrl` + `C` avoids all of that, which is why it
is worth the few seconds.

In the setup page, the **Stop** button beside **Start saving** stops a run the same way. So
does `Ctrl` + `C` in the terminal you started the setup assistant from — it stops the run
first, which means waiting for the photo in flight, and a second `Ctrl` + `C` closes
straight away.

`run` finishes with an exit code your scheduler can read: **0** when it reached the end of
the feed, and **0** when you stopped it and nothing failed — a stop you asked for is not a
failure. It is **1** when a photo failed to save.

### If a run is interrupted

A run can also end early for reasons you did not choose: your Brightwheel session expires
part-way through, the connection drops, the disk fills up. In every case:

- **Everything already saved stays saved.** The files are on disk, and before the run gives
  up it writes down that it has them — and says so plainly if it could not.
- **The next plain `run` finishes the job.** It starts again at the newest post and works
  back, recognises the photos it already has, and downloads only the rest.
- **You do not need `--all`.** That option is for re-checking an archive you think is wrong,
  not for recovering from an interruption.

A power cut or a force-quit is the one case where the tool gets no chance to write anything
down. Nothing is lost — the files are on disk — but up to a couple of dozen of them are
downloaded a second time on the next run, and you end up with a duplicate of each.

The tool only moves its "everything up to here is done" marker for a child when a run has
walked that child's whole feed with nothing left behind. An interrupted run holds the newest
photos and nothing older, so treating its newest photo as the marker would silently skip the
rest of the feed for ever. It does not.

### Adding them to Apple Photos (Mac, optional)

Off unless you turn it on, under **Settings and Maintenance** on the setup page. Each run then
also adds its new photos to the Photos app, in a folder called **Brightwheel** with the same
folders and weekly albums as your archive folder. If you use iCloud Photos, that means they
are uploaded to your iCloud account — which is why it is off, and why it only covers photos
saved after you turn it on unless you ask for the earlier ones too.

It works by running [one short AppleScript](packages/care-album-saver/applescript/add-to-photos.applescript)
that you can read first. [docs/PHOTOS.md](docs/PHOTOS.md) explains the whole thing.

### Keeping it up to date

The setup page asks once whether to check for new versions. Say yes and it asks GitHub once a
day, while the page is open, and shows a gold **New version** button when there is one, with
the steps for the way you installed it — a clone, a download, Docker or a package manager. For
a clone like the one above, updating is `git pull`, `pnpm install` and `pnpm build`.
[docs/UPDATING.md](docs/UPDATING.md) has every way, and exactly what the check sends;
[docs/UPDATE-CHECK.md](docs/UPDATE-CHECK.md) explains how the check works and what a release
must consist of for it to keep working.

---

## What gets written into each photo and video

Photo and video apps disagree about which field means "when was this taken", so this tool
writes all of the common ones. Your files land on the right day in whichever app you use.

### About the dates, honestly

**The photos Brightwheel gives you have no information in them at all.** Not the date, not
the place, nothing — we checked, on a real account. Whatever your child's teacher's phone
recorded when it took the picture is gone by the time the photo reaches you. So if you save
a photo from the website, your computer stamps it with the moment you clicked, and a year of
them lands in your photo app in one meaningless heap.

This tool gives each photo the time it was **posted to Brightwheel**, which the app does
tell us, and writes it into the file properly. For a nursery that is usually minutes after
the picture was taken and nearly always the same day, so the photos sort correctly and land
in the right week.

What it cannot do — and we would rather say so than let you find out later — is recover the
exact moment the shutter clicked. That information does not survive the trip through
Brightwheel. An earlier version of this page claimed otherwise, on the strength of a field
name every other open-source Brightwheel client also assumes means capture time. On the one
real account this has been checked against, that field is identical to the upload time on
every record. [The evidence, in full](docs/DECISIONS.md#b2-there-is-no-capture-time-to-recover).

You can check your own account, which is the point of the tool being honest about this:

```sh
care-album-saver verify          # reads the API, downloads nothing
care-album-saver verify --deep   # also reads three photos, then deletes them
```

The second one answers "does the date survive inside the photo on *my* nursery's account?"
If it ever does, please open an issue — it would be worth supporting.

### The picture itself is never changed

**The picture itself is never altered or re-compressed.** Only the metadata is touched, so
the file you keep is the file Brightwheel served. The tests check this the hard way, on both
kinds: for a photo, the compressed scan — the part of the file that is the picture — is
compared byte for byte against what the server sent; for a video, the `mdat` box that holds
the frames is compared the same way, and — on a machine that has `ffprobe` — the rewritten
container is then read back to prove it still plays. Both checks live in
`packages/care-album-saver/test/real-media-fixtures.test.js`, in the tests named "photo
metadata round-trips…" and "video metadata round-trips…".

### The `.json` file beside each photo

Every file also gets a `.json` file beside it, in plain text, so the archive is readable in
twenty years without this tool and without ExifTool. **It holds more than the photo does:**
your child's name and their Brightwheel id, the nursery's name, the teacher's note, and who
posted it — all of it, whatever the switches above are set to. That is deliberate, because
the sidecar stays behind when you share the photo. It also means the `.json` file is the one
thing in your archive you should not paste into a public bug report.

### `archive.json`

One more file sits at the top of your photos folder. `archive.json` is the tool's memory:
every file it has saved, with its size, a checksum and where it came from. That is what
makes the second run quick — a photo it recognises is never fetched twice. It also holds one
marker per child, recording how far the last complete pass through that child's feed
reached, which is where the next run starts. "Where it came from" includes the child's name,
the teacher's note and who posted it, so treat `archive.json` like the `.json` files: not
for a public bug report either.

Paths inside it are written with forward slashes on every platform, so an archive built on
Windows reads on a Mac or Linux and back again. Do not delete it: without it the tool has
forgotten everything and downloads the lot a second time, alongside the copies you already
have.

### The fields, in detail: photos

| Field | Holds |
|---|---|
| `EXIF:DateTimeOriginal`, `CreateDate`, `ModifyDate` | The time it was **posted** to Brightwheel, as the clock read there (see [About the dates, honestly](#about-the-dates-honestly)) |
| `EXIF:OffsetTimeOriginal`, `OffsetTimeDigitized` | The timezone offset, so that local time is unambiguous |
| `IPTC:DateCreated`, `TimeCreated`, `DigitalCreationDate`, `DigitalCreationTime` | The same moment, with the offset, for older galleries |
| `XMP-photoshop:DateCreated`, `XMP-xmp:CreateDate`, `ModifyDate` | The same moment again, for Immich and web galleries |
| `XMP-iptcExt:PersonInImage` | Your child's name — only with the names switch on |
| `IPTC:Keywords`, `XMP-dc:subject` | Your child's name and `Brightwheel`, as searchable tags — only with the names switch on |
| `XMP-dc:description`, `IPTC:Caption-Abstract`, `EXIF:UserComment` | The teacher's note — only with the names switch and **Keep the teacher's note** both on |
| `XMP-dc:creator` | Who posted it — only with the names switch on |
| `XMP-iptcExt:LocationCreatedSublocation` | The nursery's name, when Brightwheel gives one — only with the names switch on |

### The fields, in detail: videos

An MP4 or MOV is a QuickTime container, and none of the EXIF fields above exist inside one.
**`DateTimeOriginal` is not written to a video**, because it is not a QuickTime tag: asking
for it anyway buries it in a block that no video app consults for the date, while the
container keeps saying whenever the file was encoded. These are the fields video apps
actually read:

| Field | Holds |
|---|---|
| `QuickTime:CreateDate`, `ModifyDate` | The time it was **posted**, written in UTC as the QuickTime specification requires |
| `QuickTime:TrackCreateDate`, `TrackModifyDate`, `MediaCreateDate`, `MediaModifyDate` | The same instant, in the track and media headers |
| `Keys:CreationDate` | The same moment as local time with its offset — the field Apple Photos prefers |
| `XMP-photoshop:DateCreated`, `XMP-xmp:CreateDate`, `ModifyDate` | The same moment again, for Immich and web galleries |
| `XMP-iptcExt:PersonInImage` | Your child's name — only with the names switch on |
| `XMP-dc:subject`, `Keys:Keywords` | Your child's name and `Brightwheel`, as searchable tags — only with the names switch on |
| `XMP-dc:description`, `Keys:Description` | The teacher's note — only with the names switch and **Keep the teacher's note** both on |
| `XMP-dc:creator`, `Keys:Author` | Who posted it — only with the names switch on |
| `XMP-iptcExt:LocationCreatedSublocation` | The nursery's name, when Brightwheel gives one — only with the names switch on |

So a video's headers hold UTC while its week folder is named for the local day. Both are
right — each follows its own convention — and a player that reads the header converts it
back to the local time it was posted.

One consequence worth knowing before it surprises you: run plain `exiftool` on an archived
video and `CreateDate` reads as the UTC wall clock, with no zone beside it, which can look
hours off. Photo and video apps show the local time, because they convert it. Both are the
same instant; only the hex editor sees UTC.

---

## Advanced and technical

Everything from here on is for people comfortable in a terminal, or curious about how the
tool is built. None of it is needed to save your photos.

### Commands and options

| Command | What it does |
|---|---|
| `setup` | Open the setup assistant in your browser. Easiest way to start. |
| `login` | Paste your session in the terminal instead. |
| `run` | Save any new photos. `Ctrl` + `C` stops it after the photo it is on. |
| `schedule` | Show whether new photos are being saved automatically, when the next run is, and how the last one went. |
| `schedule on --at <HH:MM>` | Save new photos every day at that time, using your computer's own scheduler. Without `--at` it is 19:00. |
| `schedule off` | Stop saving them automatically. |
| `schedule on --replace` | Move the daily run to this copy when another copy of the tool set it up. Without it, this copy leaves the other one's alone. |
| `children` | List the children on your account, with the id Brightwheel uses for each. |
| `recheck` | Ask Brightwheel who is on the account now, compare that with the archive, and say if anyone is not being saved. |
| `check` | Compare the photos folder with the tool's own list of it (`archive.json`). Changes nothing. |
| `check --repair` | The same, and then fix the list, without downloading anything. |
| `duplicates` | Find photos saved twice, and show them. Deletes nothing. |
| `duplicates --remove` | The same, and then offer to delete the extra copies. It lists them and asks you to type `yes` before deleting any. |
| `doctor` | Check everything is working. To find out whether your session still works it sends Brightwheel one request with it, the same one a run starts with (`GET /users/me`). It never prints your session, only a short fingerprint of it — but it does print your folder paths, which contain your computer's user name. |
| `verify` | Check that Brightwheel's API still has the shape this tool expects. Read-only: it saves no photos, and prints no names, notes or ids. |
| `verify --deep` | The same, and also read three photos to check whether they carry a capture time or a location, then delete them. |
| `where` | Show where your files and settings are kept. |

| Option | Default | |
|---|---|---|
| `--dir <path>` | `~/Care Album Photos` | Where to save |
| `--all` | off | Re-check everything, not just new photos |
| `--child <id or name>` | every child | Only this child, for this one run. Repeat it for several. |
| `--no-name-tag` | off | Do not write any name into the photo |
| `--at <HH:MM>` | `19:00` | Time of day for the daily run, on the 24-hour clock. Used with `schedule on`. |
| `--replace` | off | Let `schedule on` or `schedule off` change a daily run that another copy of the tool set up. |
| `--port <n>` | chosen for you | Port for the setup assistant |
| `--base-url <url>` | Brightwheel's own | Point at a different API. Used by the tests. |

On Windows the default folder is `%USERPROFILE%\Care Album Photos`. If you set this tool up while it
was called `brightwheel-archive`, it keeps using the folder and the settings you already
have — nothing is moved or renamed on your disk, and `care-album-saver doctor` prints the
paths it is actually using. Once you have chosen a
folder in the setup page, that is the default instead.

`--child` takes either the id that `care-album-saver children` prints, or the child's
full name, where capitals do not matter. It changes one run only — the choice you made in
the setup page is not touched. `--help` prints this same list in the terminal.

### Running it in Docker

There is no published image. Nobody builds one for you, so build it yourself
from this repository. The session and the photos are mounted in, never baked into the image:

```sh
docker build -t care-album-saver .

docker run --rm \
  --user "$(id -u):$(id -g)" \
  -v ~/.config/care-album-saver:/config \
  -v ~/Care\ Album\ Photos:/photos \
  care-album-saver run --dir /photos
```

`--dir /photos` is what sends the photos to the folder you mounted. Naming a command at the
end of `docker run` replaces the one built into the image, and the built-in one is the only
place `--dir` would otherwise come from — so if you name `run`, name `--dir /photos` with
it, or the photos are written inside the container and thrown away when it exits.

On Linux, `--user` runs the container as you, so it can read the mounted session file —
which only your account can open — and write into the mounted photos folder. Without it the
container runs as its own user and can only write folders that user owns. Docker Desktop on
a Mac or Windows maps bind mounts itself, so the flag does no harm there.

`~/.config/care-album-saver` is the Linux location. On a Mac the session is in
`~/Library/Application Support/care-album-saver`. Run `care-album-saver where` to
print the exact folder to mount as `/config`.

There is also a `CARE_ALBUM_SESSION` environment variable, which the tool reads instead of
the session file when it is set. **Mount the file rather than use it.** An environment
variable is visible in process listings, lands in shell history, and is copied into crash
dumps; a mounted file is none of those things.

### How it works

Brightwheel has no public API. The website's photo feed — the one you scroll — is powered
by an internal paginated endpoint, so this tool reads that endpoint directly instead of
driving a browser and simulating scrolling. That makes it fast, reliable, and gentle on
Brightwheel's servers (one request at a time, with a pause between them).

**What has been checked, and against what.** One real account, at one nursery. A full run
on 21 September 2026 read the feed and saved 632 files, and `verify` then confirmed the
field names this tool relies on — and corrected one: the person who posted a photo is in
`first_name` and `last_name`, not `name`, so every archive written before that recorded no
author at all. There is no published documentation for the endpoint; the names were first
pieced together from six other open-source Brightwheel clients, and that is exactly why
they needed checking.

**Still unchecked**, and each of these is one more read away: whether pages count from 0 or
1, the largest page size the API allows, whether a higher-resolution original exists, and
how long a photo link stays valid. One account at one nursery is also not every nursery, so
if `verify` reports something different on yours, that is worth an issue. The full list of
what is settled and what is still open is in [docs/DECISIONS.md](docs/DECISIONS.md).

`care-album-saver verify` is how you check it on your own account without archiving
anything. It makes a handful of read-only requests — a few reads of the API, and a check
that a photo link still answers — and downloads no photos. Mostly it reports which fields
are present and what type each one is: never a child's name, never a note, never an id,
never a date. A few plain values do appear, and they are listed here so that nothing in the
report comes as a surprise — how many posts it counted, whether the two dates on a post
differ and by how many minutes, the internet address photos are served from, and the names (not the contents) of the security parameters on a photo link. None of that identifies anybody, which is why the report is safe to paste into
a bug report.

### For people who fork this project

If you clone or fork this repository to modify it, you might reasonably worry about
committing your own session by accident and publishing it. The project is built so that
this is hard:

- **Your session is never stored in the project folder.** It lives in your operating
  system's settings folder — `~/Library/Application Support/care-album-saver` on a Mac,
  `~/.config/care-album-saver` on Linux, `%APPDATA%\care-album-saver` on Windows.
  There is nothing in the repository to commit, because nothing is there.
- **The session is an unprintable object in the code.** Printing it, logging it, or
  putting it in an error message produces `[redacted]`, not the value. You have to call
  `.expose()` on purpose.
- **`.gitignore` blocks** browser captures (`.har`), cookie files, `.env` files, session
  files, downloaded photos, everything a run writes beside them, and the tool's own
  record files, and `scripts/verify-ignores.sh` checks each of those rules really works.
- **A secret scanner runs on every pull request** in this repository, with a custom rule
  that recognises a Brightwheel session specifically. Be aware of two real limits: GitHub's
  own built-in secret scanning does **not** know what a Brightwheel session looks like
  (custom patterns are a paid feature), and **GitHub Actions do not run in a fork** until
  the fork's owner switches them on. So treat the scanner as a helpful net, not a guarantee.
- **Everything published to npm is an allowlist** (`files` in `package.json`), so a stray
  local file cannot be included by accident. Note for contributors: never add an
  `.npmignore` — it completely overrides `.gitignore` and silently re-includes files the
  allowlist was protecting.

**If you think your session has leaked, assume you cannot delete it.** Anything pushed to a
GitHub fork stays retrievable through the upstream repository's network even after you
delete the commit or the fork — GitHub considers this expected behaviour. The only real fix
is to make the leaked session useless: sign out of Brightwheel everywhere from their
website, and change your password. That should end the session, though Brightwheel does not
document how quickly, and nobody has yet tested how soon a copied session stops working. Do
that first, before trying to rewrite history.

### How the code is laid out

| Package | |
|---|---|
| [`care-album-saver`](packages/care-album-saver) | The tool itself: API client, metadata, week folders, CLI and setup assistant. |
| [`applescript/`](packages/care-album-saver/applescript) | The one AppleScript the optional Apple Photos setting runs, kept as a file of its own so it can be read in one place. |
| [`src/ferry/`](packages/care-album-saver/src/ferry) | The service-agnostic half, kept as its own directory: downloading to a `.part` file and renaming it into place, stable identity for signed URLs, integrity checksums, safe filenames, ISO weeks and the archive list. It knows nothing about Brightwheel. |

It used to be a second package, `media-ferry`, and was folded back in on 23 September 2026.
The reason is worth recording: publishing this tool would have made it depend on
`media-ferry@0.1.0` from the public registry, a name nobody had registered — so the install
instructions could not have worked, and until someone claimed the name anybody could have
published code into the dependency graph of a tool that handles children's photos. One
package with a clearly separated directory has the same boundary and none of that.

**The tool has zero runtime dependencies.** There is no `dependencies` entry at all;
everything the code reaches for is Node's standard library. For software that
handles children's photos, every third-party package is a risk that has to earn its place,
and none needed to.

One thing does get installed alongside it, so it should be said plainly rather than tucked
behind the word "optional". `exiftool-vendored` — the package that writes dates and names
*inside* your photos — is listed as an optional dependency, and optional does not mean
off: a normal `npm install` or `npx` fetches it, along with the six packages it depends on
(a bundled copy of ExifTool, which is Perl, and five small libraries), for about 30 MB.
That is the normal case. If you would rather not have it, install with `--omit=optional`:
everything still works, and the dates, names and notes are written to the `.json` file
beside each photo instead of into the photo.

The decisions behind the design — and the alternatives turned down — are recorded in
[docs/DECISIONS.md](docs/DECISIONS.md); the threat model is in [SECURITY.md](SECURITY.md).

### Development

[![ci](https://github.com/ip2k/care-album-saver/actions/workflows/ci.yml/badge.svg)](https://github.com/ip2k/care-album-saver/actions/workflows/ci.yml)

```sh
pnpm install
pnpm build
pnpm test                        # the whole suite, against a local mock; no network needed
```

One test file on its own:

```sh
node --test --import ./scripts/test-env.js packages/care-album-saver/test/sync-resilience.test.js
```

CI runs the same suite on Ubuntu, macOS and Windows against Node 22, 24 and 26 — nine
combinations (`.github/workflows/ci.yml`); the badge above links to the latest results, with
the number of tests each one ran. Two of the tests assert owner-only file permissions, which
Windows does not have; there they are reported as skipped with the reason printed, never
quietly passed. `CARE_ALBUM_TEST_PLATFORM=win32 pnpm test` rehearses that on a Mac or Linux
machine, where the same two are reported as skipped.

The guide's images, and the one at the top of this page, come from
`node scripts/screenshots.js`, which drives the real setup page in a real browser. It needs
Chromium once: `pnpm exec playwright install chromium`.

Tests run against a built-in mock Brightwheel server with invented children. **No real
child's photo, name or session is ever in this repository**, including in the
documentation screenshots — every face and name you see in `docs/` is synthetic.

Contributions welcome. Please read [SECURITY.md](SECURITY.md) first.

## Licence

MIT. See [LICENSE](LICENSE).
