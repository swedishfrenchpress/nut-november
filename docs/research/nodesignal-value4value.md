# NodeSignal and Value4Value track research

Researched 2026-10-28 from primary sources. No applicable `AGENTS.md` or existing research-notes convention was found in this checkout or its inspected parent directories. This note records the research used for the sponsor card and `/tracks/value4value` page.

## Confirmed scope

The task brief supplies **a 300,000-sat NodeSignal-sponsored Value4Value track for the Nut November Cashu hackathon**. Treat the amount and sponsorship as organizer-provided information, not as independently verified public announcements. The sources below establish the podcast and Value4Value context; they do not establish judging criteria, prize allocation, winner count, eligibility, submission requirements, or sponsor approval of particular project ideas. Do not invent those details.

The organizer subsequently confirmed **a Cashu integration in Hopp as NodeSignal's suggested starting project**. The track remains broadly Value4Value; Hopp is an optional direction for participants looking for a concrete project, not an eligibility requirement or a confirmed judging preference.

## Hopp starting project

- The [official Hopp README](https://gitlab.com/nodesignal/hopp/-/blob/main/README.md) describes an open-source podcast player built for Podcasting 2.0 and Value4Value. It documents Lightning wallet connections through Nostr Wallet Connect, boosts, and streaming sats. The README was read through GitLab's public repository API on 2026-10-28 after the web fetch failed.
- The requested Cashu integration comes from the organizer's sponsor brief. The page invites participants to explore that integration without prescribing a wallet architecture, required feature list, or compatibility guarantees.
- The featured project links directly to the [Hopp repository](https://gitlab.com/nodesignal/hopp). The other seeds remain broader project inspiration.

## Suggested English website copy

**Title:** Value4Value

**Sponsor line:** Sponsored by NodeSignal · 300,000 sats

**Track description:** Build with Cashu to help audiences support Bitcoin podcasts and content creators. Explore voluntary tips, listener boosts, streaming sats, or tools that make giving and receiving value easier.

**Short explanation:** Value4Value lets audiences give back for content they value, through time, talent, or financial support. In Bitcoin podcasting, that can include sending sats while listening or attaching a message to a contribution.

**Sponsor description:** NodeSignal is a German-language Bitcoin podcast featuring discussions, interviews, and book reviews, supported by its listeners through Value4Value.

**Suggested links:** “Visit NodeSignal” → <https://nodesignal.space/>; “How Value4Value works” → <https://www.noagendashow.net/about/value4value>.

This is proposed editorial copy, not quoted sponsor wording. The track description presents directions to explore, not mandatory features. The sponsor description is supported by the [official NodeSignal website](https://nodesignal.space/); the explanation is supported by [No Agenda’s own model description](https://www.noagendashow.net/about/value4value) and [Fountain’s documentation](https://support.fountain.fm/article/91-what-is-podcasting-2-0).

## Primary-source findings

- **NodeSignal practices Value4Value itself.** Its website says it has no paywall or advertisers and invites listeners to contribute attention, feedback, sharing, and sats. It offers Podcasting 2.0 boosts, direct Lightning support, and a Cashu token/payment-request interface. These are observed website features, not independently tested payment flows. [Official website](https://nodesignal.space/)
- **Its coverage directly addresses the track’s theme.** Episode E102 discusses Value4Value, advertising, and monetization for independent content creators with Gigi. Its archive also lists E101 on Podcasting 2.0 and E103 on Value4Value for music and video. [E102 show notes](https://nodesignal.space/E102/), [official episode archive](https://nodesignal.space/folgen/)
- **Value4Value is broader than a payment protocol.** No Agenda describes listener contributions of time, talent, and treasure, including volunteer work and creative contributions. Financial support is one component of the model. [No Agenda](https://www.noagendashow.net/about/value4value)
- **Bitcoin podcasting provides concrete payment patterns.** Fountain documents streaming small Lightning payments while listening and sending a payment with a message, called a boost. It also describes podcaster-defined splits that can include guests and contributors. These are useful design precedents, not proof of automatic compatibility with a Cashu implementation. [Fountain documentation](https://support.fountain.fm/article/91-what-is-podcasting-2-0)
- **Podcasting 2.0 describes payment information in RSS.** The `podcast:value` element identifies the payment layer, transport, and optional suggested amount. Its `podcast:valueRecipient` children identify recipients and their relative shares. These payment-recipient splits are unrelated to hackathon prize splits. [Value specification](https://github.com/Podcastindex-org/podcast-namespace/blob/main/docs/tags/value.md), [recipient specification](https://github.com/Podcastindex-org/podcast-namespace/blob/main/docs/tags/value-recipient.md)
- **There is a relevant Cashu precedent in NodeSignal’s own ecosystem.** Its projects page presents Sovereigncast as a self-hosted open-source podcasting suite, an experimental Cashu Player prototype, and Hopp as a Podcasting 2.0 player with boost and community features. Cite these as existing work to learn from; do not imply that integration with them is required. [NodeSignal projects](https://nodesignal.space/projekte/)

## Project inspiration — suggestions, not sponsor rules

These are research-derived brainstorming ideas. None has been confirmed as a sponsor requirement or judging preference.

- **An embeddable Cashu support widget:** let an audience send a voluntary tip from a podcast episode, article, video, or creator page.
- **Cashu boosts with messages:** pair a contribution with optional feedback for the creator, with clear controls over what becomes public.
- **A listening-time payment prototype:** explore small Cashu payments during playback, with a visible budget and pause/stop controls.
- **Tools for sharing support with collaborators:** explore allocations to hosts, guests, editors, or artists; make recipient choices understandable to the sender.
- **A creator inbox:** collect contribution messages and feedback, and help creators acknowledge their supporters.

These suggestions draw on the [documented Podcasting 2.0 patterns](https://support.fountain.fm/article/91-what-is-podcasting-2-0) and [NodeSignal’s existing projects](https://nodesignal.space/projekte/). Implementers would need to evaluate Cashu-specific payment handling and interoperability separately. Avoid presenting Cashu as synonymous with Lightning or claiming universal Podcasting 2.0 compatibility.

## Authentic downloadable logo asset

**Recommended source:** [NodeSignal official podcast cover/logo JPEG](https://nodesignal.space/assets/podcast-cover.jpg)

- Exact URL: `https://nodesignal.space/assets/podcast-cover.jpg`
- Provenance: referenced by the official homepage as both the podcast cover and favicon; its HTML declares width and height of 1500 pixels.
- Download verified on 2026-10-28: HTTP 200, `Content-Type: image/jpeg`, 88,792 bytes.
- Visually inspected: square white background, black broadcast-wave/tower symbol, orange Bitcoin symbol, and black “NODESIGNAL PODCAST” wordmark. It is a complete branded image, not a transparent cutout.
- Suggested alt text: `NodeSignal podcast logo`.
- No separate official SVG, transparent logo, brand kit, or reuse-license statement was verified. Do not label the JPEG as a vector or transparent asset. For the sponsor display, use the authentic supplied image rather than reconstructing its mark.

The official JPEG is stored unchanged in the application at `public/nodesignal-logo.jpg`. The public RSS feed linked by the website returned HTTP 403 during research, so no alternative feed artwork URL is asserted. `value4value.info` also failed to load in the web tool; the explanation above instead cites directly inspected primary sources.
