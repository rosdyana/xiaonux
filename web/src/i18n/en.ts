// English strings: the source for every other locale and the fallback for any
// key a locale leaves out. Values marked (html) may hold our own markup.
// {name} placeholders are filled in by t().
// Copyright (c) 2026 xiaonux authors. SPDX-License-Identifier: Apache-2.0

const strings = {
  'meta.title': 'xiaonux — Debian Linux in your browser',
  'meta.description': 'Real Debian Linux running in your browser tab. Nothing to install. For learning Unix and inspecting files safely.',
  'lang.label': 'Language',
  'home.label': 'xiaonux home',
  'start.resume': 'Return to Linux',
  'start.running': 'Linux is still running in this tab. Your files are where you left them.',

  // start view
  'nav.project': 'Project',
  'nav.safe': 'Is it safe?',
  'start.title': 'Real Debian Linux in your browser. Nothing to install.',
  'start.sub': 'A full Linux machine runs inside this tab, on your computer. Practise the shell, run Python, inspect a suspicious file. Reset it whenever you like.',
  'start.boot': 'Start Linux',
  'start.timing': 'First start downloads about 17&nbsp;MB. After that it starts in under a second.', // (html)
  'start.lastTime': 'Last time it was ready in {s} s.',
  'sheet.head': 'Guides',
  'sheet.headNote': 'Commands typed for you, checked when they run',
  'sheet.label': 'Start with a guide',
  'card.unix.title': 'Learn Unix',
  'card.unix.desc': 'Files, pipes, permissions and processes, one command at a time.',
  'card.python.title': 'Python &amp; packages', // (html)
  'card.python.desc': 'Python 3 with pip. numpy, pandas and more install without internet.',
  'card.triage.title': 'Security lab',
  'card.triage.desc': 'Upload a file and take it apart with <code>file</code>, <code>strings</code>, <code>yara</code> and <code>strace</code>.', // (html)
  'card.try': 'Try it',
  'card.continue': 'Continue',
  'card.progress': '{done} of {total} steps done',
  'facts.label': 'How it works',
  'facts.tab': 'Runs in this tab, not on a server',
  'facts.files': 'Your files stay in this browser',
  'facts.net': 'Internet is off unless you turn it on',
  'facts.reset': 'Reset any time',
  'foot.license': 'Open source, <a href="https://github.com/rosdyana/xiaonux/blob/main/LICENSE">Apache-2.0</a>', // (html)
  'foot.licenses': 'Licenses',
  'foot.security': 'Security notes',
  'foot.source': 'Source on GitHub',
  'foot.privacy': "Privacy",
  'foot.analytics': "Analytics settings",
  'consent.label': "Analytics choice",
  'consent.text': "Can we count visits with Google Analytics? It would see which pages you open, your rough location and device type, and set cookies. It never sees what you type in Linux or your files. Nothing is sent unless you allow it.",
  'consent.allow': "Allow",
  'consent.deny': "No thanks",
  'consent.more': "Privacy details",

  // workspace bar
  'status.starting': 'Starting…',
  'status.restoring': 'Restoring…',
  'status.booting': 'Booting Linux…',
  'status.downloading': 'Downloading… {mb} MB',
  'status.ready': '<span class="long">Ready in </span>{s} s', // (html)
  'status.readyTitle': 'Time from Start to the shell prompt',
  'status.resetting': 'Resetting…',
  'status.error': 'Error: {message}',
  'stats.title': 'heap {heap} MB · fetched {mb} MB',
  'chip.aria': 'Network settings',
  'chip.off': 'Internet off',
  'chip.waiting': 'Connecting…',
  'chip.on': 'Internet on',
  'chip.blocked': 'Internet: problem',
  'bar.upload': 'Upload',
  'bar.uploadTitle': 'Upload files to /root/uploads',
  'bar.download': 'Download',
  'bar.downloadTitle': 'Download a file from /root',
  'bar.reset': 'Reset',
  'bar.resetTitle': 'Delete all changes and start fresh',
  'bar.guide': 'Guide',
  'drop': 'Drop to upload into <code>/root/uploads</code>', // (html)
  'reset.title': 'Reset the machine?',
  'reset.confirm': 'This deletes every file and change you made in it, including uploads.',
  'reset.guides': 'Your guide checks are cleared too.',
  'reset.keep': 'Keep my files',
  'reset.delete': 'Delete my files',

  // file transfer
  'transfer.wait': 'Wait for the prompt, then try again.',
  'transfer.uploading': 'Uploading {name}',
  'transfer.downloading': 'Downloading {name}',
  'transfer.uploaded': 'Uploaded to {path}',
  'transfer.downloaded': 'Downloaded {name}',
  'dl.field': 'File to download (under <code>/root</code>)', // (html)
  'dl.cancel': 'Cancel',
  'dl.submit': 'Download',

  // drawer
  'drawer.label': 'Worksheet',
  'tabs.label': 'Worksheet sections',
  'tab.guides': 'Guides',
  'tab.network': 'Network',
  'tab.safety': 'Safety',
  'guides.field': 'Guide',
  'guides.typeIt': 'Type it',
  'guides.stepDone': 'Step {n} done',
  'guides.hint': 'Press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd> to move between the terminal and this guide.',

  // network panel
  'net.title': 'Internet for the machine',
  'net.intro': 'The machine has no internet until you choose a way in. Everything that works offline (the shell, Python, the bundled packages and tools) needs nothing here.',
  'net.legend': 'Connection',
  'net.mode.off': '<b>Off</b> Nothing leaves this tab.', // (html)
  'net.mode.helper': '<b>This computer</b> Through the small xiaonux-net helper. Fast; any https site.', // (html)
  'net.mode.relay': '<b>Relay</b> Through our free relay. pip, apt and GitHub only; slower, with a daily limit.', // (html)
  'net.runHelper': 'Run xiaonux-net on this computer. It opens this page already connected.',
  'net.waitingHelper': 'Waiting for helper',
  'net.relayConnecting': 'Connecting to the relay…',
  'net.relayUnavailable': 'The relay isn\'t available right now ({message}).',
  'net.relayEnded': 'The relay session ended; it reconnects on next use. For big downloads, use the helper.',
  'net.relayPaused': 'Relay paused',
  'net.connectedHelper': 'Connected through xiaonux-net on this computer.',
  'net.connectedRelay': 'Connected through the relay.',
  'net.connecting': 'Connecting…',
  'net.disconnected': 'Disconnected. Is xiaonux-net still running?',
  'net.disconnectedDetail': 'Disconnected ({detail}). Is xiaonux-net still running?',
  'net.lost': 'Internet lost',
  'net.blocked': 'Blocked {host}: {reason}',
  'net.siteBlocked': 'Site blocked',

  // helper downloads
  'helper.title': 'Get xiaonux-net',
  'helper.intro': 'It shares your computer\'s internet with this tab only: web ports 80 and 443, never your local network. Run it, and it opens this page already paired.',
  'helper.windows': 'installer (.msi)',
  'helper.macos': 'Apple silicon and Intel (.zip)',
  'helper.linuxX64': 'x86_64 (.tar.gz)',
  'helper.linuxArm': 'ARM64 (.tar.gz)',
  'helper.mine': 'For this computer',
  'helper.sha': 'SHA-256 of {file}',
  'helper.none': 'Downloads aren\'t available on this server. Run <code>make helper-fetch</code> before deploying.', // (html)
  'helper.startStop': 'Start and stop',
  // (html)
  'helper.startStopList': '<dt>Windows</dt><dd>Start: open <b>xiaonux-net</b> from the Start menu. A window opens; keep it open while you use the machine.</dd>'
    + '<dt>macOS</dt><dd>Start: unzip, then double-click <b>xiaonux-net</b>. It runs in a Terminal window; keep it open.</dd>'
    + '<dt>Linux</dt><dd>Start: <code>tar xzf xiaonux-net-*.tar.gz &amp;&amp; ./xiaonux-net</code> in a terminal, and leave it running.</dd>'
    + '<dt>Stop</dt><dd>Press <kbd>Ctrl</kbd>+<kbd>C</kbd> in its window, or close the window. It doesn\'t install a service and doesn\'t start on its own again; run it the next time you want internet here.</dd>',
  'helper.unsigned': 'The helper isn\'t code-signed yet',
  'helper.unsignedIntro': 'Your system will warn the first time. Check the SHA-256 above against the file, then:',
  // (html)
  'helper.unsignedList': '<dt>Windows</dt><dd>SmartScreen: choose <b>More info</b>, then <b>Run anyway</b>.</dd>'
    + '<dt>macOS</dt><dd>Right-click the app, choose <b>Open</b>, then <b>Open</b> again. Or run <code>xattr -d com.apple.quarantine xiaonux-net</code>.</dd>'
    + '<dt>Linux</dt><dd>No warning. If it won\'t run, make it executable: <code>chmod +x xiaonux-net</code>.</dd>',

  // safety panel (html)
  'safety.body': '<h2>What\'s isolated</h2>'
    + '<p>Programs in this machine never run on your computer\'s processor. They run on an emulated RISC-V processor, inside WebAssembly, inside your browser\'s tab sandbox. The machine can\'t see your files or devices; it only gets what you upload.</p>'
    + '<h2>What you can do with a suspicious file</h2>'
    + '<ul><li>Static analysis of any file from any system: <code>file</code>, <code>strings</code>, <code>xxd</code>, <code>objdump</code>, <code>readelf</code>, <code>yara</code>, <code>binwalk</code>, <code>pefile</code>.</li>'
    + '<li>Read and run scripts: shell, Python, Perl.</li>'
    + '<li>Run and trace RISC-V Linux programs with <code>strace</code>, <code>ltrace</code> and <code>gdb</code>.</li></ul>'
    + '<h2>What it isn\'t</h2>'
    + '<ul><li>Windows, x86 and ARM programs don\'t run here.</li>'
    + '<li>It\'s not a hardened malware lab. With the internet on, anything you run can reach the internet from your IP address.</li>'
    + '<li>Don\'t put passwords or secrets in the machine. Follow the law and your course\'s rules.</li></ul>'
    + '<p>Uploads land in <code>/root/uploads</code> and are never marked executable. <b>Reset</b> deletes everything.</p>',

  // on-screen keys
  'keys.label': 'Extra keys',
  'keys.up': 'Up',
  'keys.down': 'Down',
  'keys.left': 'Left',
  'keys.right': 'Right',

  // licenses page
  'lic.title': 'Licenses — xiaonux',
  'lic.back': 'Back to Linux',
  'lic.heading': 'Licenses',
  'lic.lede': 'xiaonux is open source under the <a href="https://github.com/rosdyana/xiaonux/blob/main/LICENSE">Apache License 2.0</a>. This page lists everything else the site sends to your browser, with each license and where to get the source.', // (html)
  'lic.englishNote': '',
  'lic.sections': 'Sections',
  'lic.loading': 'Loading…',
  'lic.source': 'Source',
  'lic.text': 'License text',
  'lic.bundles': 'Bundles {file} from Debian {package} {version}: {license}',
  'lic.copyright': '{package} copyright',
  'lic.filter': 'Filter {n} entries',
  'lic.filterLabel': 'Filter {title}',
  'lic.colComponent': 'Component',
  'lic.colVersion': 'Version',
  'lic.colLicense': 'License',
  'lic.common': 'Common license texts',
  'lic.missing': 'The license list isn\'t on this server. Run <code>make licenses</code> and reload.', // (html)
  'lic.top': 'Back to top',
};

export type Strings = typeof strings;
export type Key = keyof Strings;

/** Per-lesson text, by lesson id. Steps are matched by position; commands are never translated. */
export type LessonText = Record<string, { title?: string; intro?: string; steps?: (string | null)[] }>;

export interface Locale { strings: Partial<Record<Key, string>>; lessons?: LessonText }

const en: Locale & { strings: Strings } = { strings };
export default en;
