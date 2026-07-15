# Orlix Keyboard 🟠⌨️

The onchain keyboard. Type `$TICKER` in **any** app — chat, notes, X, Telegram —
and Orlix drops a live chip right above the keys: **price · 24h change · AI
signal · 🚀 one-tap B20 launch**. It's a normal QWERTY keyboard the rest of the
time, and it works everywhere Android does.

```
you: ok but is $pepe still cooking
     ┌───────────────────────────────────────────────┐
orlix│ $PEPE  $0.0000071  ▲4.2%   ACTIVE   🚀 launch  │
     └───────────────────────────────────────────────┘
```

- **Backend:** `GET https://orlixai.xyz/api/keyboard?q=<ticker>` →
  `{ ok, found, token: { symbol, price, ch24, up, signal, insert, ... } }`.
  Multi-chain (Base · Robinhood · Arbitrum) via DexScreener, with a deterministic
  risk **signal** (RISKY / WATCH / QUIET / ACTIVE) from liquidity + volume.
- **Privacy:** no account, no analytics, `INTERNET` is the only permission. The
  keyboard only calls the API when the word under your cursor looks like a
  ticker; nothing else you type ever leaves the device.
- Try the concept in the browser first: **https://orlixai.xyz/keyboard**

---

## Build the APK

### Option A — GitHub Actions (zero local setup)
Push to `main` (or run the **Build Orlix Keyboard APK** workflow manually).
Download `orlix-keyboard-debug` from the run's Artifacts. Done.

### Option B — locally
Requires JDK 17 and the Android SDK (`ANDROID_HOME` set, platform 34 + build-tools).

```bash
cd keyboard/android
gradle wrapper --gradle-version 8.9   # first time only, creates ./gradlew
./gradlew :app:assembleDebug
# → app/build/outputs/apk/debug/app-debug.apk
```

---

## Sideload & enable (Android only — no iOS)

1. **Install** the APK:
   ```bash
   adb install -r app-debug.apk
   ```
   …or copy it to the phone and tap it (allow "install unknown apps").
2. Open **Orlix Keyboard** from the app drawer → **Open Keyboard Settings** →
   toggle **Orlix Keyboard** on (Android warns about keyboards seeing what you
   type — expected for any IME; ours only phones home on `$tickers`).
3. Back in the app → **Choose Input Method** → pick **Orlix Keyboard**.
4. Open any app, type `$degen`, tap the chip. 🚀

To switch keyboards later: long-press the spacebar, or use the keyboard picker
in the notification shade.

---

## Project layout

```
keyboard/
├── README.md                     ← you are here
└── android/
    ├── settings.gradle.kts
    ├── build.gradle.kts          ← AGP 8.5.2, Kotlin 1.9.24
    ├── gradle.properties
    ├── gradle/wrapper/gradle-wrapper.properties
    └── app/
        ├── build.gradle.kts      ← minSdk 26, targetSdk 34
        └── src/main/
            ├── AndroidManifest.xml
            ├── java/xyz/orlixai/keyboard/
            │   ├── OrlixKeyboardService.kt   ← the IME (QWERTY + $-ticker strip)
            │   └── SetupActivity.kt          ← two-tap onboarding
            └── res/
                ├── layout/activity_setup.xml
                ├── xml/method.xml            ← input-method descriptor
                ├── values/{strings,colors,themes}.xml
                ├── drawable/ic_launcher_*.xml
                └── mipmap-anydpi-v26/ic_launcher*.xml
```

## Roadmap
- Inline mini-chart sparkline in the chip
- Long-press a ticker → full Orlix analysis sheet without leaving the app
- Publish to Google Play (one-time $25 dev fee) once the beta settles
