# The complete guide

For parents who have never used a terminal before. Take it one step at a time — there is
nothing here you can break.

> Every screenshot below is from a test run with **invented children**. Robin and Sam Maple
> do not exist. No real child appears anywhere in this project.

---

## Before you start

You need **Node.js** — free software that runs this tool.

1. Go to [nodejs.org](https://nodejs.org) and download the version marked **LTS**.
2. Open it and click through the installer.

Then open a terminal:

- **Mac** — press `Cmd` + `Space`, type `Terminal`, press Enter.
- **Windows** — press the Start button, type `PowerShell`, press Enter.

A window with text in it appears. You type commands here and press Enter.

---

## Step 1 — Start the setup assistant

Type this and press Enter:

```sh
npx brightwheel-archive setup
```

The first time, it asks to download the tool. Say yes. Then it prints a link like
`http://127.0.0.1:52341/?token=...`.

**Copy that whole link and paste it into your browser.** You will see this:

![The setup assistant's first step, with the four instructions for finding your Brightwheel session highlighted](images/01-connect.png)

> **Why the odd-looking link?** `127.0.0.1` means *this computer*. The page is not on the
> internet — nobody else can open it. The `token` is a one-time password so that other
> programs on your computer cannot open it either.

---

## Step 2 — Connect your account

This tool never asks for your password. Instead you sign in on Brightwheel's real website
and copy one value across.

1. Open a new browser tab, go to **schools.mybrightwheel.com**, and sign in as normal
   (including the 6-digit code they send you).
2. Press **F12** on Windows, or **Option + Cmd + I** on a Mac. A panel opens.
3. Click **Application** along the top, then **Cookies** on the left, then the
   `schools.mybrightwheel.com` entry.
4. Find the row named **`_brightwheel_v2`** and copy what is in its **Value** column. It is
   a long jumble of letters and numbers.
5. Paste it into the box and press **Connect**.

If it worked, the step turns green and your children appear:

![The assistant after connecting, showing a green tick and the two children read from the account](images/02-connected.png)

> **Is it safe to copy that value?** It is a temporary pass that says you are already
> signed in. It is stored on your computer only, in a file only you can open, and sent
> only back to Brightwheel. It is not your password, and it expires.
>
> **If you ever think it has leaked**, sign out of Brightwheel everywhere from their
> website. That makes the old value useless immediately.

---

## Step 3 — Choose what you want

The defaults are sensible; you can press Start without changing anything. Open
**Advanced options** if you want to adjust things.

![The options, with name labelling, location removal and the advanced drawer highlighted](images/03-options.png)

| Setting | Default | What it means |
|---|---|---|
| Label photos with your child's name | **On** | Lets Apple Photos and similar find them by name. The name is written inside the photo file. |
| Keep the teacher's note | **On** | Saves the caption as the photo's description. |
| Remove location information | **On** | Strips GPS coordinates so a shared photo cannot reveal where it was taken. |
| Folder layout | Child, then week | Or one folder per week with all children together. |
| Where to save | `~/Brightwheel Photos` | **Avoid iCloud Drive, Dropbox or OneDrive folders** unless you want copies on their servers. |
| Only look for new photos | **On** | Much faster. Turn off to re-check from the beginning. |

---

## Step 4 — Save the photos

Press **Start saving**. The first run takes a while — it fetches everything. Later runs
take seconds, because it only looks for what is new.

![A completed run showing the saved, already-had and failed counts](images/04-done.png)

- **Saved** — new photos copied to your computer.
- **Already had** — recognised as ones you have. This is why a second run is quick.
- **Failed** — could not be fetched. Run it again later; it picks up where it stopped.

Press `Ctrl` + `C` in the terminal when you are done.

---

## What you end up with

```
Brightwheel Photos/
└── Robin Maple/
    └── 2026-W38/
        ├── README.md                              ← what this week is, in plain English
        ├── 2026-09-18_093214_7f3a9b21.jpg         ← the photo, date first so it sorts
        └── 2026-09-18_093214_7f3a9b21.jpg.json    ← the date, the note, who posted it
```

`2026-W38` means the 38th week of 2026. Weeks run Monday to Sunday. The folder's
`README.md` spells out the actual dates.

The `.json` file means the archive still makes sense in twenty years, with or without this
tool.

---

## Doing it automatically every day

### Mac or Linux

```sh
crontab -e
```

Add this line, save and close. It runs at 7pm daily:

```
0 19 * * *  npx brightwheel-archive run
```

### Windows

Open **Task Scheduler** → **Create Basic Task** → Daily → Start a program:

- Program: `npx`
- Arguments: `brightwheel-archive run`

### Docker

```sh
docker run --rm \
  -v ~/.config/brightwheel-archive:/config \
  -v ~/Brightwheel\ Photos:/photos \
  ghcr.io/OWNER/brightwheel-archive run
```

---

## When something goes wrong

Run this first — it checks everything and **hides any secrets**, so it is safe to paste
into a bug report:

```sh
npx brightwheel-archive doctor
```

| Message | What to do |
|---|---|
| *Your Brightwheel session has expired* | Normal — they expire. Run `setup` again and paste a fresh value. |
| *That does not look like a Brightwheel session* | You may have copied the **Name** column instead of **Value**. |
| *No children found on this account* | Make sure you signed in as the parent account, not a staff one. |
| *ExifTool is not installed* | Harmless. Dates and names go into the `.json` files instead. Install ExifTool to embed them. |
| Photos in the wrong week | Please open an issue — include the `.json` file (it has no private data beyond your child's name). |

---

## Questions people ask

**Will this get my account into trouble?**
It requests one page at a time with a pause between, which is gentler than scrolling the
website. It reads only your own data. We cannot promise anything on Brightwheel's behalf,
and their terms are theirs to interpret — but nothing here is aggressive.

**Does it delete anything from Brightwheel?**
No. It only reads. Nothing is ever changed or removed from your account.

**My child is in two nurseries / I have two accounts.**
Run it once per account, pointing `--dir` somewhere different each time.

**Can I use this for a child who isn't mine?**
No. Brightwheel only shows your own account's children. That is enforced by them, not by
us, and it cannot be worked around with this tool.
