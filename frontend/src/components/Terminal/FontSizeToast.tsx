interface Props {
  fontSize: number | null;
}

export function FontSizeToast({ fontSize }: Props) {
  if (fontSize === null) return null;

  return (
    <div className="font-size-toast">
      {fontSize}px
    </div>
  );
}
