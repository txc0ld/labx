# Whole-site refinement and acceptance

Base: 4bf4969, after percentage-fee source and current copy integration. Seller portal is a separate in-progress slice. User explicitly requested refinement, adversarial testing, fixes, mobile priority and an independent Claude review. Existing brand assets, typography, solid pillow buttons, black/white footer and global dot/noise texture remain.

## Design decisions

Keep financial data stationary and exact. Use concise summaries, clear primary actions and optional details for explanations. Give mobile sections space and make full amounts and identifiers readable without horizontal page scrolling. Use existing tokens and dependencies. Never insert sample raffles, activity, revenue, redemption codes or claims of live activation.

| Before | After | Why |
| --- | --- | --- |
| Button label disappears on hover/focus behind expanding decoration | Stable label on a solid accent button, a small static arrow, immediate press feedback | The action stays legible for mouse, touch and keyboard |
| Pack hover takes 800 ms with delayed shapes and also runs on keyboard focus | CSS transform transitions of 160–200 ms, hover only with a fine pointer; focus is a stationary outline | Responsive, interruptible and cheaper while preserving the embossed artwork |
| Footer entrances animate blur and translateY for 600 ms | 240 ms transform/opacity, short stagger, immediate focus reveal | Navigation appears promptly without blur painting |
| Shared reveal surfaces can stay hidden until intersection when focused | Focus immediately reveals the target without movement | Keyboard users always see the active control |
| Mobile browser chrome uses an old lavender theme color | Match the actual light canvas | Continuous color at the browser boundary |
| Unconfigured collection asks visitors to retry shortly | Accurate setup state with useful guide/perks links, retry reserved for a read error | A missing deployment is not a temporary network failure |

Root is the owner of existing shared component/style changes. Portal writer owns only its seller-specific appended styles. Integration resolves the shared file once. No change to transaction authorization, financial formulas or deployed contract approval in this presentation slice.

## Verification matrix

Every public route: 320, 390, 768, 1024, 1440 and 1920 CSS pixels. Check 200% zoom-equivalent reflow, touch capabilities, keyboard navigation, reduced motion, long schema-valid names, maximum amounts, empty/one/multiple records, artwork failure, loading/error/retry and wallet changes. Use dev-only local fixtures, never public fake data. Browser emulation is not real hardware evidence.

Native T3 browser completed an initial 320px scan of 16 routes with one h1 and no page overflow. It then lost its automation host. The user has standing approval for headless browser checks. Device listing reports iOS unavailable without macOS/Xcode and Android unavailable without its SDK, so physical-device validation remains unavailable here.

Local concurrency tests must use isolated dummy records and bounded requests. Inspect pagination, RPC fan-out, timeouts and atomic writes. Do not use local throughput to claim a production concurrent-user capacity; infrastructure/provider quotas need their own evidence. Defensive security tests target local fixtures only.

Final gates: integrated contract/web regressions, typecheck/build, responsive browser and accessibility checks, independent behavioral verification, fresh Astra review and actual Claude second review on the final candidate. Fix validated defects before publication. Prepare a separate v3 migration packet; the existing deployed v2 cannot adopt this policy in place.

## Mobile navigation follow-up

Native Preview became available again on 7 October. At390 CSS pixels the menu had44-pixel tap targets but only10.88-pixel text in a216-pixel central grid. A reviewed CSS change uses13-pixel text and the available header width, with automatic column wrapping at narrow or enlarged-text widths. Active links remain transparent with an underline. The source change still requires the final integrated build and responsive sweep. Browser experiment screenshot: browser-screenshot-127-0-0-1-muxwcl0i-21259dd2.png under T3 browser-artifacts.

Android device ap35 was listed but device_open failed to boot. iOS remains unavailable because this host lacks macOS/Xcode. These are not successful device tests.
