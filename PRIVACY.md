# EviCap Privacy Policy

**Effective date:** [DATE]
**Last updated:** [DATE]

This policy explains how the EviCap browser extension ("EviCap", "the extension") handles information. EviCap is provided by **Civil Digital** ("we", "us", "our"). You can contact us at **info@civildigital.co.uk**.

> **In short:** EviCap stores everything it records and captures **only on your own device**: inside your browser, and in a folder on your computer that you choose. We do not run servers that receive your data, and we cannot see, access, recover or share your cases, browsing logs or captures. The only information that leaves your device is the billing information needed to manage a paid subscription, plus a hash (fingerprint) of your captures if you choose to turn on trusted timestamping.

---

## 1. Information EviCap processes on your device

When you use EviCap, the extension creates and stores the following **locally, on your computer**:

| Category | What it includes | When |
|---|---|---|
| **Case information** | Case names, reference numbers, investigator and organisation names, descriptions, notes and tags you enter | When you create or edit a case |
| **Browsing activity log** | Addresses (URLs) and titles of pages visited, redirect chains, referring pages, navigation type, tab and window identifiers, visit times and time spent on each page | Only while a case is active **and** recording is switched on. Sites on your denylist are never logged. |
| **Page captures** | Page content and code (HTML, MHTML, WACZ/WARC web archives), screenshots, page text, page metadata, network request and response data (including headers), the website's server IP address and TLS certificate details | Automatically while recording, if auto-capture is on, or when you request a capture |
| **Images and videos** | Image and video files you select, their source addresses, embedded metadata (for example EXIF data in photos), captions, and recordings of a browser tab you choose to record, including its audio | Only when you select or record them |
| **Keyword matches** | Words or patterns you add to a case's watch list and where they appeared | While recording, if you use this feature |
| **Integrity records** | Cryptographic hashes (SHA-256) of everything captured, a hash-chained audit log of actions, digital signatures, a signing key created on your device, and timestamp tokens if you turn on trusted timestamping | Automatically with every capture and action |
| **Technical environment** | Extension version, browser and version, operating system, screen and window size, timezone and system clock time | Recorded with each capture so the evidence can be documented |
| **Settings** | Your preferences, denylist, shortcuts, cached subscription status and any licence key you enter | When you change settings or your subscription is checked |

**Where it is stored:** in your browser's local extension storage (IndexedDB, the Origin Private File System and `chrome.storage.local`) on your device. You can also choose a folder on your computer (the "disk mirror"). EviCap then saves a copy of each case there as ordinary files, so your evidence is not lost if the extension is uninstalled or your browser data is cleared. EviCap never uploads that folder. If the folder is synced to a cloud service such as OneDrive, Dropbox, Google Drive or iCloud Drive, that service will upload the files, so choose a folder that isn't synced if you want your evidence to stay on your device. Files you export are saved wherever you choose.

**We never receive any of this information.** It is not sent to us or to any server we operate, and EviCap contains no analytics, telemetry, advertising, tracking or crash-reporting code.

## 2. Network connections EviCap makes

The only information EviCap sends off your device is billing information (section 2.2) and, if you turn it on, a hash for trusted timestamping (section 2.3). EviCap makes network connections only for the following purposes.

### 2.1 Websites you capture
To save an original copy of a page, image or video you chose to capture, EviCap may re-request that item from the website it came from, as your browser normally does to display it. These requests go only to the website hosting the content. As with normal browsing, that website may see your IP address, browser details and any cookies your browser sends to it. EviCap does not send your case data to these websites.

### 2.2 Billing and subscriptions (Lemon Squeezy)
Card subscriptions to EviCap Pro are sold by **Lemon Squeezy** (lemonsqueezy.com), which acts as the reseller ("merchant of record"): you buy from Lemon Squeezy, which processes the payment and handles sales tax, and then pays us.

- **Buying:** the buttons in EviCap open Lemon Squeezy's checkout in a normal browser tab. You give your **email address** and **payment details** to Lemon Squeezy on its own pages. EviCap never sees or stores your card details.
- **Activating:** Lemon Squeezy emails you a licence key. When you paste it into EviCap, the extension sends Lemon Squeezy the **key** and a label for your computer naming your browser and operating system (for example "EviCap on Edge, Windows 11"). Lemon Squeezy returns the key's status, an activation ID for your computer, and your plan and the email address you bought with, which EviCap stores on your device.
- **Checking:** about once a day while a key is entered, EviCap sends the key and the activation ID to check that the subscription is still active. If the check can't be made, EviCap keeps working on the last answer for up to 14 days.
- **Removing:** removing the key in EviCap tells Lemon Squeezy to release the activation, so you can use the key on another computer.
- **What we see:** as the vendor, we can see the information Lemon Squeezy makes available to sellers, such as your name, email address, country, plan, order and subscription history, and your activations (with the computer labels above). We use it only to provide, support and account for your subscription, and to meet legal and tax obligations.

**No case data, browsing logs, captures or files are ever sent as part of billing.**

**Paying by invoice.** If your organisation buys EviCap from Civil Digital by invoice or purchase order, we hold the details needed to invoice you and set up your users: your organisation's name, billing contact details, the email addresses of licensed users, and payment records. We send each user a licence key to enter in EviCap. The key contains the user's email address, organisation name and licence dates. EviCap checks it on your device without contacting us or anyone else.

Lemon Squeezy's handling of your information is governed by its own privacy policy: https://www.lemonsqueezy.com/privacy

If you only use the free features, EviCap makes no billing connection at all. It contacts Lemon Squeezy only after you paste a subscription licence key. **The 14-day free trial runs entirely on your device**: starting it sends nothing to anyone.

### 2.3 Optional trusted timestamping (off by default)
If you **choose to turn on** trusted timestamping, EviCap sends a **cryptographic hash** of a capture, of a case's audit log, or of an export to **FreeTSA** (freetsa.org), a free Time Stamping Authority. A hash is a short fixed-length fingerprint (for example `sha256:9f86d0…`). The original content cannot be reconstructed from it. **No URLs, page content, files, case details or personal information are sent.** As with any internet connection, FreeTSA can see your IP address and when each request is made. FreeTSA returns a signed timestamp token, which EviCap stores locally. FreeTSA's own terms and privacy policy apply to that connection. You can turn this feature off at any time.

### 2.4 Browser updates
Your browser's extension store (for example the Chrome Web Store or Microsoft Edge Add-ons) checks for and installs EviCap updates. That is handled by the browser and the store under their privacy policies, not by EviCap.

## 3. How information is used

Information processed on your device is used only to provide EviCap's features:
- recording and displaying your browsing log
- capturing, hashing, signing and verifying evidence
- searching your cases
- producing reports and exports

Billing information is used only to manage your subscription.

We do **not**:
- sell, rent or trade any information
- use any information for advertising, profiling or creditworthiness
- transfer information to data brokers
- use information for any purpose unrelated to EviCap's single purpose of capturing and preserving web evidence

## 4. Chrome Web Store Limited Use

EviCap's use of information received from browser APIs complies with the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), including the **Limited Use** requirements. Web browsing activity and website content are used only to provide the user-facing evidence-capture features described above. They are stored only on your device and are not transferred to us or any third party.

## 5. Permissions EviCap requests

| Permission | Why EviCap needs it |
|---|---|
| Read and change data on all websites | To log visits and capture pages, images and videos on any site you investigate |
| Tabs, web navigation, web requests (read-only) | To record which pages you visit, their titles and redirect chains |
| Debugger | To make full forensic captures (complete page archives, full-page screenshots, network and certificate details). It is used only while a capture you start is running, and Chrome shows a notice bar while it is active. |
| Tab capture, offscreen documents | To record video and audio from a tab when you ask it to |
| Page capture, scripting, active tab, context menus, side panel | To save pages, show capture tools and menus, and display the live log |
| Storage, unlimited storage | To store your evidence locally without the normal size limits |
| Downloads | To save exports you request |
| Alarms | To re-check your plan on the device periodically (for example, to notice that a trial or licence has ended), and to check a subscription licence key with Lemon Squeezy about once a day, only once you have entered one, and to run scheduled timestamping if you turn it on |

## 6. Retention and deletion

- **You control your data.** It stays on your device until you delete it.
- You can delete individual captures or whole cases inside EviCap. To keep the chain of custody intact, deleting a capture removes its content but leaves a record in the case's audit log noting that it was deleted, when, its original hash and the reason you gave.
- **Uninstalling EviCap, or clearing your browser's site and extension data, permanently deletes all data stored inside the browser.** Your disk-mirror folder and exported files are not affected. Because we never hold a copy, **we cannot recover lost data**. Set up the disk mirror, and keep backups of that folder.
- Billing records held by Lemon Squeezy are kept according to its policies and our legal and tax record-keeping obligations. Invoice records we hold ourselves are kept for as long as UK accounting and tax law requires. To ask us to delete billing information we can access, contact us at info@civildigital.co.uk.

## 7. Security

- Evidence is stored inside your browser profile on your device. Its security depends on the security of your device and operating system account. Use full-disk encryption and a strong device password.
- Disk-mirror files are ordinary files and are not encrypted by EviCap. Full-disk encryption protects them along with the rest of your device. Any change to them is detected by their hashes and signatures.
- Captured web content is displayed in a sandbox isolated from the extension's privileged functions.
- If enabled, optional per-case passphrase encryption protects stored case data with AES-256. If you lose the passphrase, we cannot recover the data.
- All of EviCap's code is packaged inside the extension. It loads no remote code.

## 8. Your responsibilities when capturing content

Captures may contain personal information about other people, such as the authors or subjects of posts, photos or profiles. **You decide what to capture and why, and you are responsible for doing so lawfully.** For example, under data protection laws such as the UK GDPR/EU GDPR, you (or your organisation) are usually the "controller" of that information, and you should comply with any applicable laws, warrants, policies and platform terms. Because EviCap never transmits this information to us, we do not act as your data processor for it.

## 9. Children

EviCap is a professional tool and is not directed at children under 16. We do not knowingly collect information from children.

## 10. Your rights

Data captured by EviCap stays on your device, so you can access, export, correct or delete it directly in the extension at any time.

For billing information we hold or can access, you may have rights under applicable law (for example under the UK/EU GDPR or California law) to:
- access it
- correct it
- delete it
- restrict or object to its processing
- receive it in a portable format
- complain to a data protection authority

Contact us at info@civildigital.co.uk to exercise these rights.

Where the GDPR applies, our legal basis for processing billing information is the performance of our contract with you (providing the subscription) and compliance with legal obligations (tax and accounting records).

## 11. International transfers

Evidence data never leaves your device, so it is not transferred anywhere. If you turn on trusted timestamping, only hashes are sent to FreeTSA. Billing information is processed by Lemon Squeezy and its payment processors, which may process it in the United States and other countries under their own safeguards.

## 12. Changes to this policy

If we change how EviCap handles information, we will update this policy and the "Last updated" date. If a change would send any additional data off your device, we will tell you in the extension before it takes effect. Any such feature will be opt-in.

## 13. Contact

**Civil Digital**
Email: info@civildigital.co.uk
