# Privacy

xiaonux runs on your own computer, inside your browser tab. There is no account and no server running your machine. This page lists everything that does leave your browser, and everything it keeps.

## Analytics (only if you allow it)

The first time you visit, xiaonux asks whether it may count visits with **Google Analytics**, through Google Tag Manager.

- **Until you press Allow, nothing is loaded from Google and nothing is sent to Google.** "No thanks", or ignoring the question, keeps it that way.
- If you allow it, Google receives what analytics normally collects: the pages you open on xiaonux.dev, roughly where you are (from your IP address), your browser and device type, and how you reached the site. Google sets cookies (`_ga`, `_ga_*`) to recognise return visits.
- It **never** receives what you type in the terminal, your commands, or the files inside the machine or the ones you upload and download. Those stay in the tab.
- You can change your mind at any time with **Analytics settings** at the bottom of the start page. Turning it off deletes the Google Analytics cookies and reloads the page without them.

Google's handling of this data is covered by [Google's privacy policy](https://policies.google.com/privacy).

## What stays in your browser

Kept in your browser's storage on your computer, never sent anywhere:

- **The machine's disk.** Your changes to Linux are saved in the browser's private file storage (OPFS). **Reset** deletes them.
- **Downloaded system files**, cached so the next start is fast.
- **A few settings** in `localStorage`: your language (`xiaonux.lang`), which guides you finished (`xiaonux.lessons.done`), whether the guide panel is open (`xiaonux.drawer`), how fast the last start was (`xiaonux.lastPrompt`), and your analytics choice (`xiaonux.analytics`). Network settings are not saved; they last only while the tab is open.

Clearing the site's data in your browser removes all of it.

## What the site's hosting sees

The website is served by Cloudflare Pages. Like any web host, Cloudflare handles your requests for the site's files, including your IP address, and keeps short-lived logs to run and protect the service. See [Cloudflare's privacy policy](https://www.cloudflare.com/privacypolicy/).

## When you turn the network on

The network is **off** until you turn it on.

- **xiaonux-net helper:** connections go out from your own computer, to the sites the machine contacts, as if you'd opened them yourself.
- **Relay:** connections go through a xiaonux relay on Cloudflare Workers, and only to package servers (Python, Debian, GitHub). Starting it shows a Cloudflare Turnstile check, which loads a script from Cloudflare. The relay passes traffic through without storing it. When a session ends it logs only which host names were reached and how many bytes went each way, to keep the free service within its limits; it does not log what was sent.

## Questions

Open an issue or a discussion at https://github.com/rosdyana/xiaonux.
