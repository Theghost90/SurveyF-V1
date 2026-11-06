import { Fragment } from 'react';

/** Renders the few `<b>…</b>` spans our own dictionary uses, without dangerouslySetInnerHTML. */
export function Rich({ text }: { text: string }) {
  return (
    <>
      {text.split(/(<b>.*?<\/b>)/g).map((part, i) => {
        const m = /^<b>(.*)<\/b>$/.exec(part);
        return m ? <b key={i}>{m[1]}</b> : <Fragment key={i}>{part}</Fragment>;
      })}
    </>
  );
}
