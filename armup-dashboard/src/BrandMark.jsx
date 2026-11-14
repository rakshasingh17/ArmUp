// The ArmUp lotus mark. Loaded relative to the app so it also works in the
// built Electron window (an absolute "/brand/..." would break under file://).
export default function BrandMark({ size = 32 }) {
  return (
    <img
      src={`${import.meta.env.BASE_URL}brand/armup-mark.png`}
      alt=""
      width={size}
      height={size}
      draggable={false}
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.25) }}
    />
  );
}
