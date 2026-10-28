"use client";

import Image from "next/image";
import Link from "next/link";
import {
  CSSProperties,
  PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { peelAt, Point, revealSpot, toClipPath } from "./peelGeometry";
import { playSnap, PeelVoice, startPeel } from "./peelSound";
import type { PrizeCardData } from "./prizes";

// Seed-packet silhouette: a pinked (zig-zag) top edge where the packet was
// cut, and rounded bottom corners. Drawn on a 500×640 box, which matches the
// card's 50:64 aspect ratio so the mask never distorts.
const TEETH = 25;
const PINKED_EDGE = Array.from({ length: TEETH * 2 + 1 }, (_, i) =>
  `L${(i * 500) / (TEETH * 2)} ${i % 2 ? 0 : 9}`
).join("");
const SHAPE_PATH = `M0 9${PINKED_EDGE}V614A26 26 0 0 1 474 640H26A26 26 0 0 1 0 614Z`;
const SHAPE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 640" preserveAspectRatio="none"><path fill="#fff" d="${SHAPE_PATH}"/></svg>`;
const SHAPE_URL = `url("data:image/svg+xml,${encodeURIComponent(SHAPE)}")`;
const shapeMask: CSSProperties = {
  maskImage: SHAPE_URL,
  WebkitMaskImage: SHAPE_URL,
  maskSize: "100% 100%",
  WebkitMaskSize: "100% 100%",
};

const MAX_TILT = 12;

function prefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export default function PrizeCard({
  prize,
  amount,
}: {
  prize: PrizeCardData;
  amount: number;
}) {
  const sceneRef = useRef<HTMLDivElement>(null);
  // React ids contain characters that break CSS url(#…) references
  const outlineId = `word-outline-${useId().replace(/[^\w-]/g, "")}`;
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [corner, setCorner] = useState<Point | null>(null);
  // Tilt is written straight to the DOM once per frame: re-rendering React on
  // every mouse move made Safari stutter.
  const cardRef = useRef<HTMLDivElement>(null);
  const tiltFrame = useRef<number | null>(null);
  const [visible, setVisible] = useState(false);

  const cornerRef = useRef<Point | null>(null);
  const drag = useRef<{
    offset: Point;
    last: Point;
    travelled: number;
    voice: PeelVoice | null;
  } | null>(null);
  const anim = useRef<number | null>(null);
  const hold = useRef<number | null>(null);

  const rest = useCallback(
    (w: number): Point => ({ x: w - w * 0.075, y: w * 0.075 }),
    []
  );

  const moveCorner = useCallback((p: Point) => {
    cornerRef.current = p;
    setCorner(p);
  }, []);

  // Track the card's pixel size; the peel maths needs real dimensions.
  useEffect(() => {
    const el = sceneRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ w: width, h: height });
      if (!drag.current && anim.current === null && hold.current === null)
        moveCorner(rest(width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [moveCorner, rest]);

  // Only animate the artwork while the card is on screen.
  useEffect(() => {
    const el = sceneRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      rootMargin: "100px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(
    () => () => {
      if (anim.current !== null) cancelAnimationFrame(anim.current);
      if (hold.current !== null) clearTimeout(hold.current);
    },
    []
  );

  const applyTilt = (x: number, y: number, transition: string) => {
    const card = cardRef.current;
    const scene = sceneRef.current;
    if (!card || !scene) return;
    card.style.transition = transition;
    card.style.transform = `rotateX(${x}deg) rotateY(${y}deg)`;
    scene.style.setProperty("--mx", `${50 + y * 3}%`);
    scene.style.setProperty("--my", `${50 - x * 3}%`);
    scene.style.setProperty("--hx", `${y * 1.5}%`);
    scene.style.setProperty("--hy", `${-x * 1.5}%`);
  };

  const cancelTiltFrame = () => {
    if (tiltFrame.current !== null) cancelAnimationFrame(tiltFrame.current);
    tiltFrame.current = null;
  };

  const local = (e: ReactPointerEvent): Point => {
    const r = sceneRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const clampCorner = (p: Point): Point => ({
    x: Math.min(size.w - 1, Math.max(-size.w * 0.9, p.x)),
    y: Math.min(size.h * 1.4, Math.max(1, p.y)),
  });

  const stopAnim = () => {
    if (anim.current !== null) cancelAnimationFrame(anim.current);
    if (hold.current !== null) clearTimeout(hold.current);
    anim.current = null;
    hold.current = null;
  };

  /** Ease the corner back onto the card and slap it down. */
  const springBack = () => {
    stopAnim();
    const home = rest(size.w);
    const from = cornerRef.current ?? home;
    const distance = Math.hypot(from.x - home.x, from.y - home.y);
    const step = () => {
      const cur = cornerRef.current ?? home;
      const next = { x: cur.x + (home.x - cur.x) * 0.2, y: cur.y + (home.y - cur.y) * 0.2 };
      if (Math.hypot(home.x - next.x, home.y - next.y) < 0.5) {
        moveCorner(home);
        anim.current = null;
        if (distance > 30) playSnap(distance / size.h);
        return;
      }
      moveCorner(next);
      anim.current = requestAnimationFrame(step);
    };
    anim.current = requestAnimationFrame(step);
  };

  /** Tap or keyboard: peel most of the way, hold, then let go. */
  const autoPeel = () => {
    stopAnim();
    const from = cornerRef.current ?? rest(size.w);
    const to = { x: size.w * 0.12, y: size.h * 0.62 };
    const voice = startPeel();
    const t0 = performance.now();
    const duration = 520;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / duration);
      const e = 1 - Math.pow(1 - k, 3);
      moveCorner({ x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e });
      voice?.update((1 - e) * 30);
      if (k < 1) {
        anim.current = requestAnimationFrame(step);
      } else {
        voice?.stop();
        anim.current = null;
        hold.current = window.setTimeout(springBack, 1100);
      }
    };
    anim.current = requestAnimationFrame(step);
  };

  const onHandleDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (!size.w) return;
    e.preventDefault();
    stopAnim();
    e.currentTarget.setPointerCapture(e.pointerId);
    cancelTiltFrame();
    applyTilt(0, 0, "none");
    const p = local(e);
    const c = cornerRef.current ?? rest(size.w);
    drag.current = {
      offset: { x: p.x - c.x, y: p.y - c.y },
      last: p,
      travelled: 0,
      voice: startPeel(),
    };
  };

  const onHandleMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d) return;
    const p = local(e);
    const speed = Math.hypot(p.x - d.last.x, p.y - d.last.y);
    d.travelled += speed;
    d.last = p;
    d.voice?.update(speed);
    moveCorner(clampCorner({ x: p.x - d.offset.x, y: p.y - d.offset.y }));
  };

  const onHandleUp = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    applyTilt(0, 0, "transform 600ms cubic-bezier(.2,.8,.2,1)");
    d.voice?.stop();
    if (d.travelled < 4) autoPeel();
    else springBack();
  };

  const onSceneMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "mouse" || drag.current || prefersReducedMotion()) return;
    const r = e.currentTarget.getBoundingClientRect();
    const nx = (e.clientX - r.left) / r.width - 0.5;
    const ny = (e.clientY - r.top) / r.height - 0.5;
    cancelTiltFrame();
    tiltFrame.current = requestAnimationFrame(() => {
      tiltFrame.current = null;
      applyTilt(-ny * 2 * MAX_TILT, nx * 2 * MAX_TILT, "transform 120ms cubic-bezier(.2,.8,.2,1)");
    });
  };

  const onSceneLeave = () => {
    cancelTiltFrame();
    if (!drag.current) applyTilt(0, 0, "transform 600ms cubic-bezier(.2,.8,.2,1)");
  };

  const peel = size.w && corner ? peelAt(size.w, size.h, corner) : null;
  const keptClip = peel ? toClipPath(peel.kept) : undefined;
  // What's under the sticker sits in the middle of the uncovered patch, and
  // fades and grows in as the patch opens up (the resting curl shows none).
  const spot = peel ? revealSpot(peel.lifted) : null;
  const reveal =
    spot && size.w ? Math.min(1, Math.max(0, (spot.area / (size.w * size.h) - 0.03) / 0.06)) : 0;

  const amountDigits = Math.round(amount).toLocaleString("en-US");
  const amountLabel = `${amountDigits} sats`;
  // Shrink the amount for bigger numbers so a 7–8 digit pool still fits the band.
  const tagSize = Math.min(11, 62 / (amountDigits.length * 0.7));

  return (
    <div
      ref={sceneRef}
      className="prize-card-scene relative w-full aspect-[50/64] [perspective:1100px] select-none"
      onPointerMove={onSceneMove}
      onPointerLeave={onSceneLeave}
      style={{ containerType: "inline-size" }}
    >
      {/* The packet's shadow on the table: blurred copies of the silhouette
          (contact and soft). They stay put while the card tilts above them,
          and aren't filter: drop-shadow, which Safari redraws every frame. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 translate-y-4 opacity-45 blur-[18px]">
        <div className="h-full w-full bg-bark-dark" style={shapeMask} />
      </div>
      <div aria-hidden className="pointer-events-none absolute inset-0 translate-y-[3px] opacity-35 blur-[2px]">
        <div className="h-full w-full bg-bark-dark" style={shapeMask} />
      </div>

      <div ref={cardRef} className="prize-card relative h-full w-full">
        {/* Everything that lives inside the card silhouette */}
        <div className="absolute inset-0 overflow-hidden" style={shapeMask}>
          {/* 1. The art: a foil finish unique to each prize (see globals.css). It
                 shows through the lettering and fills the card when peeled. */}
          <div
            className="prize-holo absolute inset-0"
            data-finish={prize.finish}
            data-paused={visible ? undefined : ""}
          >
            <span className="prize-holo-bands" />
            <span className="prize-holo-foil" />
            <span className="prize-holo-glare" />
          </div>

          {/* 2. The sticker: cream paper with black type, screen-blended over the
                 art. Screen keeps light paper light and lets black show the art
                 untouched, so the art only comes through the lettering (and,
                 faintly, through the darker print dots). */}
          <div
            className="prize-sticker absolute inset-0 mix-blend-screen"
            style={{ clipPath: keptClip }}
          >
            <Word text={prize.word} className="text-black" />
          </div>

          {/* Warms the white paper to cream. The word is white here (multiply by
                 white changes nothing) so the foil in the letters stays bright.
                 Its own layer: the print's clip-path would isolate the blend. */}
          <div
            className="prize-paper-tint absolute inset-0"
            style={{ clipPath: keptClip }}
          >
            <Word text={prize.word} className="text-white" />
          </div>

          {/* 3. The print: sits on the sticker (and peels with it) but isn't blended */}
          <div
            className="absolute inset-0 text-bark"
            style={{ clipPath: keptClip }}
            aria-hidden
          >
            {/* One chunky outline around the whole word. The filter grows the
                letters' combined silhouette and keeps only the ring outside it,
                so overlapping letters merge instead of showing inner outlines. */}
            <svg width="0" height="0" className="absolute" aria-hidden>
              <filter id={outlineId} x="-5%" y="-20%" width="110%" height="140%">
                <feMorphology in="SourceAlpha" operator="dilate" radius={Math.max(1.5, size.w * 0.007)} result="fat" />
                <feMorphology in="SourceAlpha" operator="erode" radius="0.6" result="thin" />
                <feComposite in="fat" in2="thin" operator="out" result="ring" />
                <feFlood floodColor="#5C2E12" />
                <feComposite in2="ring" operator="in" />
              </filter>
            </svg>
            <div className="absolute inset-0 [transform:translateZ(0)]" style={{ filter: `url(#${outlineId})` }}>
              <Word text={prize.word} className="text-bark" />
            </div>

            {/* The prize money, printed on a band across the packet */}
            <p className="absolute inset-x-0 top-[34%] flex items-baseline justify-center gap-[2cqw] bg-pumpkin py-[2.6cqw] leading-none text-cream">
              <span
                className="font-extrabold font-stretch-expanded tracking-[-0.01em] tabular-nums"
                style={{ fontSize: `${tagSize}cqw` }}
              >
                {amountDigits}
              </span>
              <span className="font-bold font-stretch-condensed uppercase tracking-[0.04em] text-[5cqw]">
                sats
              </span>
            </p>

            <div className="absolute left-[7%] right-[7%] top-[56%]">
              <p className="font-bold leading-tight text-[7cqw]">{prize.title}</p>
              <p className="mt-[2cqw] text-[4.6cqw] leading-snug text-bark/85">
                {prize.blurb}
              </p>
            </div>

            {!prize.sponsor && (
              <div className="absolute left-[7%] right-[7%] bottom-[5%] flex items-end justify-between gap-[3cqw] border-t-[0.6cqw] border-bark pt-[3cqw]">
                <Field label="Track" value={prize.track} />
                <NuttyStamp />
              </div>
            )}

            {/* Thick packet outline; half the stroke falls outside the mask */}
            <svg
              viewBox="0 0 500 640"
              preserveAspectRatio="none"
              className="absolute inset-0 h-full w-full"
              fill="none"
            >
              <path d={SHAPE_PATH} stroke="var(--bark)" strokeWidth="12" strokeLinejoin="round" />
            </svg>
          </div>

          {/* 4. The prize's own nut (or sprout, or palette) hiding under the
                 sticker, clipped to the uncovered patch */}
          {peel && spot && reveal > 0 && (
            <div className="absolute inset-0" style={{ clipPath: toClipPath(peel.lifted) }} aria-hidden>
              <span
                className="absolute leading-none"
                style={{
                  left: spot.x,
                  top: spot.y,
                  fontSize: Math.min(spot.radius * 1.5, size.w * 0.3),
                  opacity: reveal,
                  transform: `translate(-50%, -50%) scale(${0.5 + reveal * 0.5})`,
                }}
              >
                <span className="prize-reveal">{prize.reveal}</span>
              </span>
            </div>
          )}

          {/* Tilt sheen across the whole card */}
          <div className="prize-card-sheen pointer-events-none absolute inset-0" />
        </div>

        {/* Keep the sponsor link accessible outside the decorative print layer.
            It peels with the paper and stays separate from the peel button. */}
        {prize.sponsor && (
          <div className="pointer-events-none absolute inset-0 text-bark" style={{ clipPath: keptClip }}>
            <div className="absolute left-[7%] right-[7%] bottom-[5%] flex items-end justify-between gap-[3cqw] border-t-[0.6cqw] border-bark pt-[3cqw]">
              <div>
                <Field label="Sponsored track" value={prize.sponsor.name} />
                <span className="mt-[1cqw] block text-[4.2cqw] font-bold underline underline-offset-4">
                  Explore the track <span aria-hidden="true">→</span>
                </span>
              </div>
              <Image src={prize.sponsor.logo} alt="" width={72} height={72} className="h-auto w-[17cqw] shrink-0 border-[0.6cqw] border-bark" />
            </div>
            <Link
              href={prize.sponsor.href}
              aria-label={`Explore the ${prize.title} track sponsored by ${prize.sponsor.name}`}
              className="pointer-events-auto absolute inset-x-[1.2%] top-[48%] bottom-[1%] rounded-b-[4cqw] transition-colors hover:bg-bark/5 focus-visible:outline-offset-[-4px]"
            />
          </div>
        )}

        {/* The lifted flap, mirrored across the fold */}
        {peel && (
          <div className="pointer-events-none absolute inset-0">
            <div
              className="absolute inset-0 origin-top-left"
              style={{
                ...shapeMask,
                clipPath: toClipPath(peel.lifted),
                transform: peel.mirror,
                background: peel.shading,
              }}
            />
          </div>
        )}

        <button
          type="button"
          aria-label={`Peel back the ${prize.title} sticker`}
          className="absolute right-0 top-0 z-10 h-[20%] w-[20%] cursor-grab touch-none rounded-tr-[6%] outline-none focus-visible:ring-4 focus-visible:ring-pumpkin active:cursor-grabbing"
          onPointerDown={onHandleDown}
          onPointerMove={onHandleMove}
          onPointerUp={onHandleUp}
          onPointerCancel={onHandleUp}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              autoPeel();
            }
          }}
        />
      </div>
      <p className="sr-only">
        {prize.title}: {amountLabel}. {prize.blurb}
      </p>
    </div>
  );
}

/** The big knockout word. Rendered in several layers, always at the same spot. */
function Word({ text, className }: { text: string; className: string }) {
  return (
    <p
      className={`absolute inset-x-0 top-[9%] text-center leading-none whitespace-nowrap ${className}`}
      style={{
        fontFamily: "var(--font-sauce-tm)",
        fontSize: `${Math.min(35, 86 / (text.length * 0.42))}cqw`,
      }}
    >
      {text}
    </p>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="font-bold font-stretch-condensed uppercase tracking-[0.04em] text-bark text-[3.6cqw]">
        {label}
      </p>
      <p className="mt-[0.4cqw] font-semibold truncate text-[4.2cqw]">{value}</p>
    </div>
  );
}

/** The hero's "100% nutty" sticker, shrunk down for the packet. */
function NuttyStamp() {
  const ringId = useId();
  return (
    <div className="relative w-[17cqw] shrink-0 aspect-square rotate-6 rounded-full border-[0.6cqw] border-cream-deep bg-bark outline outline-[0.4cqw] outline-bark">
      <span className="absolute inset-0 flex items-center justify-center text-[4.6cqw]">
        🌰
      </span>
      <svg viewBox="0 0 100 100" className="prize-stamp-ring absolute inset-0">
        <defs>
          <path id={ringId} d="M50 50m-34 0a34 34 0 1 0 68 0a34 34 0 1 0-68 0" />
        </defs>
        <text
          fill="currentColor"
          style={{ fontFamily: "var(--font-archivo)", fontStretch: "75%", fontSize: "10.5px", fontWeight: 700 }}
        >
          {/* Spaced to fill the ring exactly (2πr = 213.6) so the words never overlap */}
          <textPath href={`#${ringId}`} textLength="212" lengthAdjust="spacing">
            {"100% NUTTY\u00a0\u00a0CERTIFIED ORGANIC\u00a0\u00a0"}
          </textPath>
        </text>
      </svg>
    </div>
  );
}
