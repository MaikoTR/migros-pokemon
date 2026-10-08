# Pokémon at Migros Zofingen

A page listing every Pokémon product Migros sells and how many are in stock at the Migros stores in Zofingen, with price, Aktion and a per-store breakdown.

GitHub runs the check every 30 minutes during the day and publishes the result to GitHub Pages. Nothing runs on your own computer.

## Using it

- **Open the page:** `https://<your-github-name>.github.io/migros-pokemon/`. Add it to your phone's home screen for one-tap access.
- **Update right now:** Actions tab → *Update stock page* → *Run workflow*. The page updates about a minute later.
- **Check a different town:** in `.github/workflows/update.yml`, add `--store Oftringen --zip 4665` to the `node migros-pokemon.mjs` line.
- **Change how often it checks:** edit the `cron` line in the same file. The times are in UTC.

## When something breaks

If Migros blocks the request or returns nothing, the run fails and the last good page stays online. The *Updated* time on the page shows how old the list is. GitHub emails you when a scheduled run fails.

The script uses the same unofficial API as migros.ch, so Migros can change it at any time.

## Running it locally

Requires Node.js 18 or newer. There is nothing to install.

```sh
node migros-pokemon.mjs            # page at http://localhost:4800 with a live Refresh button
node migros-pokemon.mjs --list     # print the list in the terminal
node migros-pokemon.mjs --site public   # write the static site into ./public
```

Not affiliated with Migros.
