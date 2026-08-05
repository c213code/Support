const PALETTE = [
  { bg: "bg-indigo-100", text: "text-indigo-700", ring: "ring-indigo-200" },
  { bg: "bg-rose-100", text: "text-rose-700", ring: "ring-rose-200" },
  { bg: "bg-amber-100", text: "text-amber-700", ring: "ring-amber-200" },
  { bg: "bg-emerald-100", text: "text-emerald-700", ring: "ring-emerald-200" },
  { bg: "bg-sky-100", text: "text-sky-700", ring: "ring-sky-200" },
];

function colorFor(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

const SIZES = {
  sm: "h-5 w-5 text-[10px]",
  md: "h-7 w-7 text-xs",
  lg: "h-10 w-10 text-sm",
};

export function Avatar({
  name,
  size = "md",
}: {
  name: string;
  size?: keyof typeof SIZES;
}) {
  const { bg, text, ring } = colorFor(name);
  const initial = name.trim().charAt(0).toUpperCase();

  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold ring-1 ${bg} ${text} ${ring} ${SIZES[size]}`}
      title={name}
    >
      {initial}
    </span>
  );
}
