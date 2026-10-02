---
name: awesome-design-md
description: Library of 74 DESIGN.md files - the design language of well-known product sites (Stripe, Linear, Apple, Vercel, Notion, Spotify, Ferrari, IBM Carbon...) written out as colour and type tokens, spacing, components and do/don't rules. Use when asked to make something look like a named site or brand, to borrow one specific technique from a mature design system, or to write a DESIGN.md.
---

# Awesome DESIGN.md

74 design systems from [VoltAgent/awesome-design-md](https://github.com/VoltAgent/awesome-design-md)
(MIT, see `LICENSE`; vendored at `f696123, 2026-09-21`). Each is one markdown file in
`references/<brand>.md`, in Google Stitch's DESIGN.md shape: most open with YAML
tokens (`colors`, `typography`, `rounded`, `spacing`, `components`) and
follow with prose on layout, depth, motion and do/don't rules. Ten older ones
(kraken, lamborghini, lovable, mastercard, runwayml, sanity, spotify, starbucks,
tesla, theverge) are prose only.

## How to use it

1. Pick from the index below. Read **one** file, not the folder: they run
   4-60 KB each and the whole set is over 2 MB.
2. To borrow a technique rather than a whole look, grep across them instead:
   `grep -il "tabular" references/*.md`, `grep -l "letterSpacing: -" references/*.md`.
3. Treat the values as an analysis, not the brand's official spec. Several
   files are "inspired interpretations" that deliberately misspell the brand
   (Stripi, Sentri, Slacc) for that reason, and proprietary faces (Sohne, SF
   Pro, Saans) are named but not licensed to you.
4. Never ship something that passes itself off as the real company: borrowing
   a type ramp is study, cloning a brand's page under its name is not.

## In Ride The Bus

The game has its own system and it wins: `web-sdk/apps/Ride-The-Bus/design.md`
(what the system is) and `src/styles/tokens.css` (its values), with Hallmark
as the design skill that reads them. Use these files to study how a mature
system specifies something the game's does not yet (a tabular-figure rule, a
depth ladder, a focus treatment), then express it in the game's own tokens.
Never import a brand's palette or face into the game.

## Index

| File | The look, in its own words |
|---|---|
| `airbnb` | A warm, generous consumer marketplace anchored on a clean white canvas and Airbnb Rausch (#ff385c), the single brand voltage that carries every… |
| `airtable` | A sober, editorial workflow-software interface anchored on white canvas and dark-ink type, where brand voltage comes from full-bleed signature cards… |
| `apple` | A photography-first interface that turns marketing into a museum gallery |
| `binance` | A confident financial-platform interface anchored on a deep near-black canvas, where Binance's iconic yellow (#FCD535) carries every primary CTA… |
| `bmw` | BMW's corporate site |
| `bmw-m` | A motorsport-engineering interface anchored on a near-black canvas with white BMW Type Next Latin display headlines in confident UPPERCASE |
| `bugatti` | An austere luxury-automotive interface that uses near-pure black canvas, white uppercase letterspaced display, and full-bleed automotive photography… |
| `cal` | A clean, calendar-software-first interface anchored on white canvas with black primary CTAs and custom Cal Sans display typography |
| `claude` | A warm-canvas editorial interface for Anthropic's Claude product |
| `clay` | A vibrant claymation-meets-data interface for Clay.com (GTM data-orchestration platform) |
| `clickhouse` | A high-performance database interface anchored on near-pure black canvas with electric yellow as the brand voltage |
| `cohere` | Cohere's 2026 web system is a controlled enterprise AI interface built from stark white editorial space, deep green-black product bands, soft mineral… |
| `coinbase` | An institutional-grade crypto exchange whose marketing surfaces read like a quietly-confident financial-services brand |
| `composio` | A developer-tools brand for AI-agent tool integration whose marketing surfaces lean into a dark, technical aesthetic with a single deep-electric-blue… |
| `cursor` | An AI-first code editor whose marketing site reads like a quietly-confident developer-tools brand with a warm-cream editorial canvas (#f7f7f4)… |
| `dell-1996` | A catalog-era enterprise web design built around a literal black page frame, vivid flat color-block "ribbon cards" tinted in sage, salmon… |
| `elevenlabs` | A voice-AI brand whose marketing surfaces read like a quietly editorial print magazine |
| `expo` | A React Native developer-platform whose marketing site reads like a quietly-confident infrastructure brand |
| `ferrari` | A luxury-automotive brand whose marketing surfaces read as cinematic editorial |
| `figma` | A confident black-and-white editorial frame interrupted by oversized, hand-cut pastel color blocks |
| `framer` | A confident dark-canvas builder marketing site that treats the page like a working artboard |
| `hashicorp` | An enterprise-infrastructure marketing canvas built around a near-black ground (#000000) and a system of per-product accent colors |
| `hp` | A white-paper enterprise-consumer system anchored by HP Electric Blue (#024ad8) as the lone signal CTA, near-black ink (#1a1a1a) for headlines… |
| `ibm` | An enterprise-marketing canvas faithful to Carbon Design System: white surfaces, charcoal type, IBM Blue (#0f62fe) as the single confident accent… |
| `intercom` | An editorial customer-service marketing canvas built around a soft cream-white ground, charcoal type set in Saans (Intercom's proprietary geometric… |
| `kraken` | Kraken's website is a clean, trustworthy crypto exchange that uses purple as its commanding brand color |
| `lamborghini` | Lamborghini's website is a cathedral of darkness |
| `linear.app` | A near-black product-focused marketing canvas built around #010102 (the deepest dark surface of any tool in this collection), light gray text… |
| `lovable` | Lovable's website radiates warmth through restraint |
| `mastercard` | Mastercard's experience reads like a warm, editorial magazine built from soft stone and signal orange |
| `meta` | Meta's design system spans hardware commerce (Quest VR, Ray-Ban Meta AI glasses) and brand surfaces with a confident product-merchandising voice |
| `minimax` | MiniMax presents itself as a premium AI infrastructure brand through a striking duality |
| `mintlify` | Mintlify presents documentation infrastructure with a dual-mode aesthetic |
| `miro` | Miro presents itself as the AI-powered visual workspace through a confident, almost playful brand voice |
| `mistral.ai` | Mistral AI brands itself with a singular signature |
| `mongodb` | MongoDB carries a strong dual-mode visual identity |
| `nike` | A photography-first commerce system built on extreme typographic contrast |
| `nintendo-2001` | A brushed-periwinkle "console chrome" interface where every panel is a beveled metal plate, navigation glows amber over a halftone-dotted carbon bar… |
| `notion` | Notion presents itself as the all-in-one workspace through a confident, illustration-rich brand voice |
| `nvidia` | An engineering-grade marketing system organized around two surface modes |
| `ollama` | An almost defiantly minimal documentation-first system that treats the home page like a Markdown README |
| `opencode.ai` | A terminal-native marketing system rendered entirely in Berkeley Mono |
| `pinterest` | A photography-first discovery system organized around the Pinterest Red CTA, the masonry pin grid, and a soft warm-cream chrome that gets out of the… |
| `playstation` | A three-surface marketing system organized around alternating black, white, and PlayStation Blue chapters that scroll past the viewer like a console… |
| `posthog` | A playful developer-tools system rendered on a warm cream canvas with hand-drawn hedgehog mascots dotted across every page like marginalia in a… |
| `raycast` | Raycast's marketing system reads like an extended product screenshot |
| `renault` | Renault's web presence pairs the freshly-modernised Renault diamond (the 2021 flat-line rhombus mark) with a stark black-and-white canvas, a… |
| `replicate` | Replicate's marketing surfaces pair the warm-cream developer-tools aesthetic of an indie ML playground with a confident hot-orange brand accent and a… |
| `resend` | Resend's marketing surfaces sit on a near-pure black canvas with off-white text and a single signature color |
| `revolut` | Revolut's marketing surfaces pair a stark black canvas with the brand's cobalt-violet (#494fdf) and a wide accent palette of deep, fully-saturated… |
| `runwayml` | Runway's interface is a cinematic reel brought to life as a website |
| `sanity` | Sanity's website is a developer-content platform rendered as a nocturnal command center -- dark, precise, and deeply structured |
| `sentry` | A developer-tools brand built on a deep purple-violet midnight canvas, electric lime accents, and a slightly subversive illustrated personality |
| `shopify` | A cinematic commerce platform that runs two parallel design tracks |
| `slack` | A workplace messaging brand built on a deep aubergine primary, with cream-lavender hero gradients, blue inline links, and pill CTAs |
| `spacex` | A mission-oriented aerospace brand built on pure black canvas, full-bleed photographic and video heroes of rockets and Mars landscapes, and uppercase… |
| `spotify` | Spotify's web interface is a dark, immersive music player that wraps listeners in a near-black cocoon (#121212, #181818, #1f1f1f) where album art and… |
| `starbucks` | Starbucks' design system is a warm, confident retail flagship wearing the green of their storefront apron across every surface |
| `stripe` | A financial-infrastructure brand built on a deep navy ink, an electric indigo primary, and a recurring atmospheric gradient mesh that occupies the… |
| `supabase` | An open-source database platform built on a clean white-and-near-black system with a single signature emerald-green CTA, a custom humanist sans… |
| `superhuman` | A fast-email productivity brand split between an editorial dark hero (deep indigo navy with violet-sky atmospheric backdrop and a portrait subject)… |
| `tesla` | Tesla's website is an exercise in radical subtraction |
| `theverge` | The Verge's 2024 redesign feels like somebody wired a Condé Nast magazine to a chiptune soundboard |
| `together.ai` | An AI infrastructure platform whose surface alternates between near-black hero bands (with a three-color orange-magenta-periwinkle gradient as the… |
| `uber` | A transportation-and-delivery super-app brand whose web surface is a black-and-white duet, framed by a custom geometric display sans, accented by a… |
| `vercel` | A developer-platform brand whose surface is a stark black-and-ink duet on near-white canvas, broken at hero scale by a multi-color mesh gradient… |
| `vodafone` | A telecom super-brand whose web surface alternates between editorial photography hero bands with massive uppercase display headlines and clean white… |
| `voltagent` | A developer-focused AI agent engineering platform whose surface is an unrelenting near-black canvas broken only by a single electric-green brand… |
| `warp` | An agentic terminal-and-development-environment brand whose surface is a warm near-charcoal canvas (a tint warmer than pure black), broken only by… |
| `webflow` | A visual web development platform whose surface contrasts a deep near-black #080808 primary against a generous white canvas, broken by a five-stop… |
| `wired` | A flagship technology-magazine brand whose surface is a strict editorial duet of stark black wordmark on white canvas, anchored by a tall narrow… |
| `wise` | A global money-transfer brand whose surface combines an unusually heavy near-black display sans (weight 900 at 64–126 px) with a vivid lime-green… |
| `x.ai` | Elon Musk's frontier-AI company whose web surface is a strict near-black canvas broken only by white pill outlines, occasional warm sunset / dusk… |
| `zapier` | A workflow-automation platform whose surface combines warm-cream neutrals (#fffefb canvas, #f8f4f0 soft cream) with deep coffee ink (#201515) and a… |
