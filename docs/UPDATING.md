# Updating Care Album Saver

Your photos, your settings and your Brightwheel session are kept outside the program's own
folder, so updating never touches them. Updating replaces the program and nothing else.

## Finding out that there is a new version

The setup page can tell you. The first time you see your archive it asks, once, whether to
**check for new versions once a day**. If you say yes, a gold **New version** button appears
beside Settings whenever a newer release exists; it opens what is new in it and the steps for
the way you installed it. You can change your answer at any time in **Settings and
Maintenance → Maintenance → Updates**, which also shows the version you are running and has
a **Check now** button.

What that check sends, exactly:

- one request, to `https://api.github.com/repos/ip2k/care-album-saver/releases/latest`;
- at most once a day, and only while the setup page is open — the daily run never checks;
- no cookie, no token and no User-Agent of its own (Node's default, `node`, which every Node
  program sends).

GitHub learns your computer's internet address and that it asked about this project. Nothing
about your Brightwheel account, your children or your photos is sent, because the program
doing the asking does not put any of it in the request. If you say no, nothing is ever sent.

You can also watch the repository's
[releases page](https://github.com/ip2k/care-album-saver/releases) instead: each release lists
what changed.

## How to update

The page works out how you installed it and shows only your steps. Here they all are.

### You cloned it with git (the way the README describes)

```sh
cd care-album-saver        # wherever you cloned it
git pull
pnpm install
pnpm build
```

Then stop the setup page (Ctrl+C in its terminal) and start it again. The daily run, if you
set it up, runs the program from this folder, so it uses the new version from its next run
with nothing else to change. If `git pull` says you have changes of your own, `git stash` puts
them aside first.

### You downloaded it as a ZIP, without git

Download the new version's **Source code (zip)** from its release page, and put its contents in
place of your folder's — same name, same place. Then, in that folder:

```sh
pnpm install
pnpm build
```

Keeping the folder where it was means the daily run carries on with the new version.

### You run it in Docker

In the clone you built the image from:

```sh
git pull
docker build -t care-album-saver .
```

The next `docker run` uses the new image. Your session and photos are in the folders you
mount into the container, so nothing else changes.

### You installed it from npm (once it is published there)

Care Album Saver is not on npm yet. When it is, a global install is updated with the same
package manager that installed it:

```sh
npm install -g care-album-saver@latest     # npm
pnpm add -g care-album-saver@latest        # pnpm
yarn global add care-album-saver@latest    # Yarn
bun add -g care-album-saver@latest         # Bun
```

A copy run with `npx`, `pnpm dlx`, `yarn dlx` or `bunx` keeps using the version it downloaded
first until it is asked for the newest one:

```sh
npx care-album-saver@latest setup
```

(or `pnpm dlx`, `yarn dlx`, `bunx` in place of `npx`). A daily run cannot be set up from a
copy like that — the package manager can delete its cache at any time — which is one more
reason to install it properly.

### You deployed it with scripts/deploy.js

This is the arrangement the project's own maintainer uses: a development checkout, and a
production copy on `main` that the daily run uses. Update the development checkout, then deploy:

```sh
cd <your development checkout>
git switch main
git pull
node scripts/deploy.js
```

`deploy.js` builds and tests the new version in production, moves the daily run onto it, and
puts production back on the version it was on if anything fails.

## After updating

The setup page shows the new version under **Settings and Maintenance → Maintenance →
Updates**, and the gold button goes away. Nothing needs to be set up again: your connection,
your children, your folder and your daily run all carry over.
