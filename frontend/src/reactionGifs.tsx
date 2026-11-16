import heart from "./reactions/heart.gif";
import pray from "./reactions/pray.gif";
import clap from "./reactions/clap.gif";
import hands from "./reactions/hands.gif";
import grin from "./reactions/grin.gif";
import laugh from "./reactions/laugh.gif";
import thumb from "./reactions/thumb.gif";
import sparkheart from "./reactions/sparkheart.gif";
import party from "./reactions/party.gif";
import sparkles from "./reactions/sparkles.gif";
import dove from "./reactions/dove.gif";
import plead from "./reactions/plead.gif";

/** Transparent animated GIF for every reaction. The emoji character stays the signal sent between participants. */
export const REACTION_GIFS: Record<string, string> = {
  "❤️": heart, "🙏": pray, "👏": clap, "🙌": hands, "😁": grin, "😂": laugh,
  "👍": thumb, "💖": sparkheart, "🎉": party, "✨": sparkles, "🕊️": dove, "🥺": plead,
};

/** Reactions sent by participants still running the previous version map onto their new animated equivalent. */
const LEGACY_REACTIONS: Record<string, string> = { "😊": "😁", "💛": "💖" };

export const REACTION_SET = Object.keys(REACTION_GIFS);

export function normalizeReaction(emoji: unknown): string | null {
  if (typeof emoji !== "string") return null;
  const key = LEGACY_REACTIONS[emoji] || emoji;
  return REACTION_GIFS[key] ? key : null;
}

let reactionGifsPreloaded = false;
/** Decode every GIF ahead of time so a reaction never pops in half-loaded. */
export function preloadReactionGifs() {
  if (reactionGifsPreloaded || typeof Image === "undefined") return;
  reactionGifsPreloaded = true;
  for (const src of Object.values(REACTION_GIFS)) {
    const img = new Image();
    img.decoding = "async";
    img.src = src;
  }
}

export function ReactionGif({ emoji }: { emoji: string }) {
  const key = normalizeReaction(emoji);
  if (!key) return <>{emoji}</>;
  return <img className="reaction-gif" src={REACTION_GIFS[key]} alt="" width={64} height={64} draggable={false} decoding="async" />;
}
