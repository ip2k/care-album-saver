# Brightwheel Archive

**Save your own child's photos from Brightwheel onto your own computer, sorted into a folder for each week.**

Your childcare provider posts photos of your child to Brightwheel. Those photos live on
Brightwheel's servers. This tool copies them onto your computer, gives each one the correct
date, labels it with your child's name, and files it in a folder for the week it was taken.

Run it once a day and you build up a complete, private archive of your child's time at
nursery — one you keep, whatever happens to your account.

```
Brightwheel Photos/
├── Robin Maple/
│   ├── 2026-W37/          ← 8–14 September 2026
│   │   ├── 2026-09-09_084512_a1b2c3d4.jpg
│   │   ├── 2026-09-09_084512_a1b2c3d4.jpg.json
│   │   └── README.md
│   └── 2026-W38/
└── Sam Maple/
```

---

## Privacy and security

**This is the most important section in this file. It is written for everyone, not just
for programmers.**

### Where do my child's photos go?

Two places, and only two places:

1. **Brightwheel's service**, where they already are.
2. **The computer you run this on**, in the folder you choose.

That's it. There is no third place. This tool has no website, no account, no server, and
no company behind it. Nothing is uploaded anywhere. Nobody — including the people who
wrote this — can see your photos, your child's name, or which nursery they go to.

### Can anyone else see them?

| | |
|---|---|
| **Does this tool send my photos anywhere?** | No. They go from Brightwheel straight to your computer. |
| **Does it collect usage data or analytics?** | No. It makes no network connections except to Brightwheel. |
| **Can the authors see anything?** | No. There is nothing to see. There is no server. |
| **Can other parents see my child's photos?** | No. Brightwheel only ever shows this tool the children on *your* account. |
| **Can I archive someone else's child?** | No. This is not a limitation we added — it is how Brightwheel works. Your login only reaches your own family. |

### What about my password?

**By default, this tool never asks for and never sees your Brightwheel password.**

You sign in on Brightwheel's own website, exactly as you always do, including the
6-digit code they text or email you. Then you copy one value — a "session", which is
like a temporary ticket that says "this person is already signed in" — and paste it in.

That session is stored **on your computer only**, in your private settings folder, in a
file only your user account can open. It is never sent anywhere except back to
Brightwheel.

There is also an **optional** sign-in that asks for your email, password and the 6-digit
code directly, for people who find copying the session too fiddly. It is off by default and
you have to choose it. If you do: your password is used only for the few seconds it takes
to get a session, is never written to disk, and is never logged. We still suggest the
default, because getting into the habit of typing your real password into other people's
software is a bad habit to build — even when the software is honest.

### The setup page that opens in your browser

When you run the setup assistant, a page opens at an address starting `127.0.0.1`. That
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
  (`~/Brightwheel Photos`) avoids this, but if you change it, check where you are pointing.
- **Photos may contain other children.** A group photo from your child's class has other
  families' children in it. Please treat those photos the way you would want yours treated.
- **Labelling photos with your child's name writes that name into the file itself.** That
  is what makes them searchable in Apple Photos and similar apps — but it also means the
  name travels with the file if you ever share it. You can turn this off.

### For people who fork this project

If you clone or fork this repository to modify it, you might reasonably worry about
committing your own session by accident and publishing it. The project is built so that
this is hard:

- **Your session is never stored in the project folder.** It lives in your operating
  system's settings folder (`~/Library/Application Support/brightwheel-archive` on a Mac).
  There is nothing in the repository to commit, because nothing is there.
- **The session is an unprintable object in the code.** Printing it, logging it, or
  putting it in an error message produces `[redacted]`, not the value. You have to call
  `.expose()` on purpose.
- **`.gitignore` blocks** browser captures (`.har`), cookie files, `.env` files, session
  files and downloaded photos.
- **A secret scanner runs on every pull request**, with a custom rule that recognises a
  Brightwheel session specifically. Generic scanners do not know what one looks like.
- **Everything published to npm is an allowlist**, so a stray local file cannot be
  included by accident.

---

## Getting started

The setup assistant walks you through everything. **[Full illustrated guide →](docs/GUIDE.md)**

```sh
npx brightwheel-archive setup
```

Then open the link it prints. Three steps: connect, choose your settings, save.

<p align="center">
  <img src="docs/images/01-connect.png" alt="The setup assistant, showing how to find your Brightwheel session" width="780">
</p>

Once you have connected once, you never need to again until the session expires:

```sh
npx brightwheel-archive run        # save any new photos
```

### Running it every day

**macOS / Linux** — add to `crontab -e`:

```
0 19 * * *  npx brightwheel-archive run
```

**Docker** — the session and photos are mounted in, never baked into the image:

```sh
docker run --rm \
  -v ~/.config/brightwheel-archive:/config \
  -v ~/Brightwheel\ Photos:/photos \
  ghcr.io/OWNER/brightwheel-archive run
```

---

## Commands

| Command | What it does |
|---|---|
| `setup` | Open the setup assistant in your browser. Easiest way to start. |
| `login` | Paste your session in the terminal instead. |
| `run` | Save any new photos. |
| `children` | List the children on your account. |
| `doctor` | Check everything is working. Safe to share — it redacts secrets. |
| `where` | Show where your files and settings are kept. |

| Option | Default | |
|---|---|---|
| `--dir <path>` | `~/Brightwheel Photos` | Where to save |
| `--all` | off | Re-check everything, not just new photos |
| `--no-name-tag` | off | Do not write your child's name into the photo |
| `--port <n>` | random | Port for the setup assistant |

---

## What gets written into each photo

Photo apps disagree about which field means "when was this taken", so this tool writes all
of the common ones. Your photos land on the right day in whichever app you use.

| Field | Holds |
|---|---|
| `DateTimeOriginal`, `CreateDate` | When the photo was taken |
| `OffsetTimeOriginal` | The timezone, so the date is unambiguous |
| `XMP-photoshop:DateCreated` | The same date, for Immich and web galleries |
| `XMP-iptcExt:PersonInImage` | Your child's name |
| `Keywords`, `XMP-dc:subject` | Your child's name, as a searchable tag |
| `XMP-dc:description` | The teacher's note |

**The picture itself is never altered or re-compressed.** Only the metadata section is
touched, so the photo you keep is the photo Brightwheel served.

Every photo also gets a `.json` file beside it with the same information in plain text —
so the archive is readable in twenty years even without this tool, and even if ExifTool is
not installed.

### Why the dates need correcting

Brightwheel records both when a photo was *taken* and when the teacher *uploaded* it —
often hours later. Downloading the file from the website gives you the upload time. A
photo taken at 9am on Friday and uploaded at 7pm lands in the wrong evening, and at a
week boundary, in the wrong week folder entirely. This tool always uses the capture time.

---

## How it works

Brightwheel has no public API. The website's photo feed — the one you scroll — is powered
by an internal paginated endpoint, so this tool reads that endpoint directly instead of
driving a browser and simulating scrolling. That makes it fast, reliable, and gentle on
Brightwheel's servers (one request at a time, with a pause between them).

### Before you use this: Brightwheel's terms

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

### The two packages

| Package | |
|---|---|
| [`brightwheel-archive`](packages/brightwheel-archive) | The tool itself: API client, metadata, week folders, CLI and setup assistant. |
| [`media-ferry`](packages/media-ferry) | Reusable and service-agnostic: resumable downloads, stable identity for signed URLs, content hashing, safe filenames, ISO weeks. Useful in any archiving project. |

**Zero runtime dependencies.** Both packages use only Node's standard library. For
software that handles children's photos, every third-party package is a risk that has to
earn its place, and none needed to. ExifTool is optional — without it, dates and names are
written to the `.json` files instead.

---

## Development

```sh
pnpm install
pnpm build
pnpm test                        # 25 tests, no network needed
node scripts/screenshots.js      # regenerate the guide images
```

Tests run against a built-in mock Brightwheel server with invented children. **No real
child's photo, name or session is ever in this repository**, including in the
documentation screenshots — every face and name you see in `docs/` is synthetic.

Contributions welcome. Please read [SECURITY.md](SECURITY.md) first.

## Licence

MIT. See [LICENSE](LICENSE).
