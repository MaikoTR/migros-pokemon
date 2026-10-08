# Pokémon at Migros around Zofingen

A page listing every Pokémon product Migros sells and how many are in stock at the Migros stores around Zofingen, with price, Aktion and a per-store breakdown.

GitHub runs the check every 30 minutes during the day and publishes the result to GitHub Pages. Nothing runs on your own computer.

## Using it

- **Open the page:** https://maikotr.github.io/migros-pokemon/. Add it to your phone's home screen for one-tap access.
- **Pick postal codes:** type a postal code or town in the box, or use *Add all*. Every postal code within 10 km of Zofingen is available. A postal code without its own Migros shows the nearest one (Aarburg, for example, shows Oftringen).
- **Share a selection:** the address updates as you add postal codes, e.g. `…/migros-pokemon/?plz=4800,4665,4600`. The page also remembers the selection on each device.
- **Update right now:** Actions tab → *Update stock page* → *Run workflow*. The page updates about a minute later.

## Postal codes

`postcodes.json` holds the 50 residential postal codes whose GeoNames centre is within 10 km of Zofingen (4800). Company and PO-box codes such as the PostFinance codes are left out. Add or remove entries to change the area. `lat`/`lng` are optional, but they let the script pick the truly nearest Migros for postal codes without their own store.

Each run looks up the stores for every postal code (about 15 stores in total) and then checks every product in those stores. Migros allows at most 10 stores per stock lookup, so one run makes roughly 120 requests.

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

Not affiliated with Migros. Postal code locations from [GeoNames](https://www.geonames.org/) (CC BY 4.0).
