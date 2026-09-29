import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
export function readPresence(bytes: Uint8Array) {
  const decoder = decoding.createDecoder(bytes);
  if (decoding.readVarUint(decoder) !== 1) throw new Error("Invalid presence");
  const id = decoding.readVarUint(decoder),
    clock = decoding.readVarUint(decoder);
  const state = JSON.parse(decoding.readVarString(decoder));
  if (decoding.hasContent(decoder)) throw new Error("Invalid presence");
  return { id, clock, state };
}
export function trustedPresence(
  bytes: Uint8Array,
  user: { name: string; color: string },
) {
  const { id, clock, state } = readPresence(bytes);
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 1);
  encoding.writeVarUint(encoder, id);
  encoding.writeVarUint(encoder, clock);
  encoding.writeVarString(
    encoder,
    JSON.stringify(
      state === null
        ? null
        : {
            cursor: state.cursor,
            user: { ...user, colorLight: user.color + "33" },
          },
    ),
  );
  return { id, bytes: encoding.toUint8Array(encoder) };
}
