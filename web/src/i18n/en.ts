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

  // start view: the cover, then the document sections
  'nav.inside': "What's inside",
  'nav.uses': 'Use cases',
  'nav.safety': 'Safety',
  'fields.label': 'About this machine',
  'fields.machine.k': 'Machine',
  'fields.machine.v': 'Debian 13, riscv64',
  'fields.runs.k': 'Runs on',
  'fields.runs.v': 'Your computer, in this tab',
  'fields.net.k': 'Internet',
  'fields.net.v': 'Off until you choose',
  'fields.login.k': 'Login',
  'fields.login.v': 'User <code>root</code>, password <code>root</code>', // (html)
  'guides.login': 'If the machine asks you to log in, the user is <code>root</code> and the password is <code>root</code>.', // (html)
  'fields.lic.k': 'License',
  'fields.lic.v': 'Apache-2.0',

  'inside.title': "What's on the machine",
  'inside.note': 'Installed and working with the internet off.',
  'inside.g1': 'Shell and system',
  'inside.g2': 'Python, offline',
  'inside.g3': 'Security tools',
  'inside.bash': 'shell',
  'inside.coreutils': 'files, text, pipes',
  'inside.sudo': 'users and permissions',
  'inside.jq': 'JSON',
  'inside.7zip': 'archives',
  'inside.xxd': 'hex dumps',
  'inside.pip': 'installs from a bundled wheel index',
  'inside.binutils': 'objdump, readelf, strings',
  'inside.aside': 'Only RISC-V Linux programs run here. Windows, x86 and ARM executables can be read and taken apart, but not run.',

  'uses.title': 'What people use it for',
  'uses.note': 'Examples from classes and security workshops. Each command runs as shown.',
  'uses.g1': 'Classrooms',
  'uses.g2': 'Security learners',
  'uses.tryUnix': 'Try the Unix guide',
  'uses.trySec': 'Try the security guide',
  'uses.c1.title': 'Zero-install lab',
  'uses.c1.desc': 'Chromebooks and locked-down PCs get a real Linux shell with no install and no account. Reset gives every student a clean machine.',
  'uses.c2.title': 'Text-processing drills',
  'uses.c2.desc': 'Count status codes in a log, pull out a field with awk, sort the unique values.',
  'uses.c3.title': 'RISC-V assembly',
  'uses.c3.desc': 'objdump and gdb read the binaries in the machine, so students see the instructions a compiler produced.',
  'uses.s1.title': 'Log forensics',
  'uses.s1.desc': 'Find the source addresses of failed logins in an uploaded auth.log.',
  'uses.s2.title': 'YARA workshop',
  'uses.s2.desc': 'Write a rule for a sample and scan a folder with it.',
  'uses.s3.title': 'Static deobfuscation',
  'uses.s3.desc': 'Decode the hidden part of a shell dropper without running it.',

  'how.title': 'How it works',
  'how.note': 'One machine, inside one tab, on your computer.',
  'how.l1.name': 'Your browser tab',
  'how.l1.desc': "The browser's own sandbox, on your computer.",
  'how.l2.name': 'WebAssembly',
  'how.l2.desc': 'The emulator, compiled to run in the page.',
  'how.l3.name': 'Emulated RISC-V CPU',
  'how.l3.desc': 'Guest code never runs on your processor.',
  'how.l4.name': 'Debian 13',
  'how.l4.desc': 'Your files are kept in this browser (OPFS).',
  'how.n1.title': 'Starts from a snapshot',
  'how.n1.desc': 'The machine resumes from a saved state, so a warm prompt arrives in about half a second.',
  'how.n2.title': 'Your changes stay',
  'how.n2.desc': 'Files you make are saved in this browser and are there next time.',
  'how.n3.title': 'Reset is one button',
  'how.n3.desc': 'It deletes your changes and returns to the shipped image.',
  'how.n4.title': 'Internet is your choice',
  'how.n4.desc': 'Off by default. Turn it on through the small xiaonux-net helper on your computer, or a free relay limited to pip, apt and GitHub.',

  'safety2.title': 'Safety, plainly',
  'safety2.note': "What is isolated, and what isn't.",
  'safety2.isoH': 'Isolated',
  'safety2.notH': 'Not isolated',
  'safety2.iso1': "Programs run on an emulated RISC-V processor inside WebAssembly, never on your computer's processor.",
  'safety2.iso2': "The machine can't see your files or devices. It only gets what you upload.",
  'safety2.iso3': 'Uploads land in <code>/root/uploads</code> and are never marked executable.', // (html)
  'safety2.iso4': 'Nothing you type or store is sent to a server.',
  'safety2.not1': 'With the internet on, anything you run can reach the internet from your IP address.',
  'safety2.not2': "It is not a hardened malware lab. Don't analyse targeted or high-value samples here.",
  'safety2.not3': "Don't put passwords or secrets in the machine.",
  'safety2.aside': 'Read the full <a href="https://github.com/rosdyana/xiaonux/blob/main/SECURITY.md">security notes</a>.', // (html)

  'oss.title': 'Open source',
  'oss.note': 'Apache-2.0. Read it, run it, change it.',
  'oss.p1': 'xiaonux is free and open source. The emulator, the page and the image build are all in one repository.',
  'oss.p2': 'Guides are small JSON files. If you teach with it, <a href="https://github.com/rosdyana/xiaonux/blob/main/CONTRIBUTING.md#contributing-lessons">write a guide</a> for your class.', // (html)
  // services: what we offer beyond the free machine
  'nav.services': 'Services',
  'svc.title': 'Your own xiaonux',
  'svc.note': 'For schools, course authors and security teams who want this machine set up for them.',
  'svc.lead': 'The machine on this page is free and stays free. When you need it shaped around your course or your team, we can build and run it with you.',
  'svc.image.title': 'Custom Debian images',
  'svc.image.desc': 'Your packages, datasets, course files and settings, built into the image, so every student starts from the same machine.',
  'svc.host.title': 'Self-hosting and embedding',
  'svc.host.desc': 'Run it on your own domain, or put it inside a course site or LMS page with your own guides beside the terminal.',
  'svc.train.title': 'Workshops and training',
  'svc.train.desc': 'Hands-on Unix and security-lab sessions for classes and teams. Nobody installs anything.',
  'svc.support.title': 'Support and consulting',
  'svc.support.desc': 'Custom features, guide writing, and help setting up a security lab for your learners.',
  'svc.ask': 'Tell us what you teach or test, and who it is for.',
  'svc.cta': 'Email contact@xiaonux.dev',
  'svc.short': 'Custom images, self-hosting, workshops and support for your course or team.',
  'svc.contact': 'Contact',
  'svc.hide': 'Hide',
  'svc.tile': 'services',
  'foot.license': 'Open source, <a href="https://github.com/rosdyana/xiaonux/blob/main/LICENSE">Apache-2.0</a>', // (html)
  'foot.licenses': 'Licenses',
  'foot.security': 'Security notes',
  'foot.source': 'Source on GitHub',
  'foot.privacy': "Privacy",
  'foot.analytics': "Analytics settings",
  'consent.label': "Analytics choice",
  'consent.text': "Can we count visits with Google Analytics? It would see which pages you open, your rough location and device type, and set cookies. It never sees what you type in Linux or your files. Nothing is sent to Google unless you allow it.",
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
  'status.notSaved': "Changes in this tab won't be saved: xiaonux is open in another tab.",
  'status.notSavedNoStorage': "Changes won't be saved: this browser doesn't allow storage here (private window?).",
  'status.resetFailed': "Reset didn't happen: {reason}",
  'reset.reason.other-tab': 'close the other xiaonux tab first',
  'reset.reason.unavailable': 'this browser has no saved changes to delete',
  'reset.reason.starting': 'wait until the machine has started',
  'stats.idle': 'idle',
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
  'drawer.label': 'Guide',
  'tabs.label': 'Guide sections',
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
  'net.relayReady': 'Relay on. Linux connects through it when it needs the network.',
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
