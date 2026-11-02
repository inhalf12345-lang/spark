# Spark — Production Stability, Mobile Browser Compatibility & Full Feature Hardening Plan

Eliminate the `Illegal constructor` crash on Android Chrome and GitHub Pages, establish silent auto-recovery from corrupted browser state, and harden all four core social and privacy subsystems end-to-end.

### User Review & Critical Decisions

> [!IMPORTANT]
> **Root Cause of `Illegal constructor` on Mobile Chrome & GitHub Pages**
> When bundled for production, native browser APIs (`window.fetch`, `Headers`, `Request`, `CustomEvent`, `Notification`, and `OffscreenCanvas` Web Workers inside `canvas-confetti` and `@supabase/supabase-js`) can lose their `this` context or invoke non-constructable bindings in mobile Chrome (`TypeError: Illegal constructor`). We will wrap all browser-native calls in safe runtime adapters, disable worker-based canvas constructors on mobile, and configure the bundler to preserve native constructors cleanly.

> [!WARNING]
> **Silent Auto-Recovery & Zero Public Infrastructure Clutter**
> If a client device encounters corrupted local cache or a runtime constructor error, the app will automatically sanitize stale state and re-mount cleanly without trapping the user on an error screen. All Supabase developer configuration menus remain hidden from public users (accessible only via the `Ctrl+Shift+S` admin shortcut).

---

### 1. Overview & Core Concept

Spark is a real-time social messaging and gamified reward web application designed for seamless cross-device access on mobile and desktop browsers. This update focuses on making the production application 100% reliable on GitHub Pages (`inhalf12345-lang.github.io/spark/` and repository static branches) and Android Chrome, ensuring every user can sign in, chat, earn rewards, and control their data privacy without encountering crashes or technical setup screens.

- **Native Browser Constructor Safety**: Prevent `TypeError: Illegal constructor` across Supabase network transports, custom DOM events, Web Crypto operations, and particle celebration effects.
- **Silent Self-Healing Runtime**: Replace blocking crash modals with automatic cache sanitization and seamless component recovery so mobile users always land directly inside the app.
- **Unified GitHub Pages & Static Bundle Sync**: Synchronize all static output targets (`dist`, `docs`, and pre-built bundle outputs) and CI/CD workflow settings so GitHub Pages serves the exact same verified build regardless of branch or folder configuration.

---

### 2. User Experience & Visual Design

- **Zero-Friction Cross-Device Onboarding**:
  - Users opening Spark on any phone, tablet, or desktop connect automatically to the built-in Supabase cloud backend without ever entering API keys or seeing database status indicators.
  - Authentication supports instant username/password sign-in, account creation, and automatic profile restoration across devices.
- **Mobile-First Ergonomics & Responsive Desktop Canvas**:
  - Touch targets across the top navigation bar, story carousel, chat composer, and modals enforce a minimum `44x44px` interactive hitbox for effortless one-handed mobile use.
  - Smooth transitions between the **Home Hub** (Stories, Daily Quests, Friend Streaks, Activity Feed) and the **Chat Workspace** (1-on-1 DMs, Group Chats, Shared Group To-Do Board, and Voice/Image messaging).
- **Clean Consumer Interface**:
  - Public screens display only consumer social features. Diagnostic SQL scripts and database connection overrides stay strictly isolated behind the secret administrator keyboard shortcut (`Ctrl+Shift+S` / `Cmd+Shift+S`).

---

### 3. Key Product Decisions & Trade-Offs

- **Decision 1 — GitHub Pages Primary Optimization**:
  - *Choice*: Use relative asset paths (`./`) with synchronized static outputs and SPA fallback routing (`404.html`), while removing strict lockfile cache failures in GitHub Actions.
  - *Trade-Off*: Keeping synchronized static build artifacts slightly increases repository size, but guarantees that GitHub Pages deployments work immediately whether served from Actions, the `/docs` folder, or branch root.
- **Decision 2 — Silent Auto-Recovery Over Blocking Error Screens**:
  - *Choice*: When the root error boundary detects a constructor or storage deserialization error, it automatically clears only the corrupted cache keys and re-renders the active view silently.
  - *Trade-Off*: A transient render fault triggers a fast, invisible state reset rather than displaying stack traces, prioritizing uninterrupted consumer usability.
- **Decision 3 — Main-Thread Canvas Rendering for Rewards**:
  - *Choice*: Configure reward celebrations (`canvas-confetti`) to run with `useWorker: false` and safe reduced-motion fallbacks.
  - *Trade-Off*: Avoids `OffscreenCanvas` worker instantiation (a frequent source of `Illegal constructor` errors on Android Chrome WebViews) with zero perceptible impact on animation smoothness.
- **Decision 4 — Strict Group Ownership & Data Precision**:
  - *Choice*: Enforce creator-only group deletion at both the UI and database service layers, and bind Data Precision toggles (E2EE, Ephemeral Mode, Telemetry Lock, and One-Tap Cloud Purge) directly to message encryption and persistence pipelines.

---

### 4. Technical Architecture & Data Strategy

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    Mobile & Desktop Browser Runtime                     │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │        Self-Healing Error Boundary & Safe Native Adapters         │  │
│  │  • Safe fetch / Headers / URL / CustomEvent / Storage wrappers    │  │
│  │  • Non-worker Canvas Confetti adapter (Android Chrome safe)       │  │
│  └───────────────┬───────────────────────────────────┬───────────────┘  │
└──────────────────┼───────────────────────────────────┼──────────────────┘
                   ▼                                   ▼
┌──────────────────────────────────────┐ ┌────────────────────────────────┐
│       Core Social & Game Views       │ │   Privacy & Security Engine    │
│  • Seamless Cross-Device Auth        │ │  • WebCrypto AES-GCM 256 E2EE  │
│  • Real-Time 1-on-1 & Group Chat     │ │    (Graceful fallback on HTTP) │
│  • Creator-Only Group Delete & To-Do │ │  • Ephemeral Auto-Expiry       │
│  • Stories, Quests, Shop & Ranks     │ │  • Data Precision & Cloud Wipe │
└──────────────────┬───────────────────┘ └─────────────┬──────────────────┘
                   │                                   │
                   └─────────────────┬─────────────────┘
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│            Built-In Supabase Cloud Backend & Realtime Engine            │
│  • Automatic credentials injection (zero user setup required)           │
│  • Row-level profiles, friendships, messages, groups, stories & quests  │
│  • Instant bidirectional WebSocket sync + local offline resilience      │
└─────────────────────────────────────────────────────────────────────────┘
```

#### Core Subsystems to Harden & Verify
1. **Browser-Native Constructor Guards**:
   - Bind `globalThis.fetch` explicitly inside the Supabase client configuration (`global: { fetch: (...args) => globalThis.fetch(...args) }`) so bundled polyfills never invoke `new Request` or `new Headers` on unbound constructors.
   - Replace raw `new CustomEvent(...)` and `new URL(...)` calls with defensive helper functions that fall back gracefully on restricted mobile browsers.
   - Wrap all `canvas-confetti` triggers in a safe utility (`useWorker: false`) across Quests, Shop purchases, Group tasks, and Chat streak milestones.
2. **Seamless Cross-Device Supabase Sync**:
   - Verify automatic connection to the built-in Supabase project on first load, profile hydration by username or user ID, and automatic cloud sync of sparks, streaks, unlocked items, and friends list across devices.
3. **1-on-1 & Group Chat with Creator Delete**:
   - Verify real-time message delivery, image/voice attachments, shared Group To-Do list rewards, and strict enforcement that only `createdBy === currentUser.id` can delete a group (removing the group and its messages cleanly for all members).
4. **Data Precision & End-to-End Encryption (E2EE)**:
   - Guard `window.crypto.subtle` and `indexedDB` inside `cryptoService` so devices or contexts with restricted WebCrypto never throw unhandled runtime errors, while preserving full AES-GCM 256-bit message encryption, metadata stripping, ephemeral message TTLs, and cloud history purge.
