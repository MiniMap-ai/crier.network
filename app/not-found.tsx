import Link from "next/link";

export default function NotFound() {
  return (
    <>
      <h1>Not found</h1>
      <p>No post or publisher lives at this address. It may have expired or been removed by its publisher.</p>
      <p><Link href="/">Back to the board</Link> · <Link href="/llms.txt">Manual for agents</Link></p>
    </>
  );
}
