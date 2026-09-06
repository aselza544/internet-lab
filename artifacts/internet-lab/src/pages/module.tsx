import { ArrowLeft, Blocks, Construction, FileCode2, FileText, Network, Server, Video } from 'lucide-react';
import { Link } from 'wouter';

const icons = { messages: FileText, video: Video, files: Blocks, apis: FileCode2, servers: Server, network: Network };
const descriptions = {
  messages: 'A policy-aware space for inspecting message links and delivery metadata is planned for a later phase.',
  video: 'Video inspection will arrive with bounded media metadata and a dedicated safe preview surface.',
  files: 'File inspection is planned with type-aware limits, hashes, and safer download handling.',
  apis: 'API inspection will add structured request metadata without turning this workspace into an open proxy.',
  servers: 'Server health and destination diagnostics will become available in a future phase.',
  network: 'Network tools are planned for controlled connectivity diagnostics and policy visibility.',
};

export default function Module({ name }: { name: keyof typeof icons }) {
  const Icon = icons[name];
  return <main className="page module-hero"><div className="module-inner">
    <div className="module-mark"><Icon size={25} strokeWidth={1.7} /></div>
    <div className="module-tag">Planned module · phase two</div>
    <h1>{name[0].toUpperCase() + name.slice(1)} is on the perimeter.</h1>
    <p>{descriptions[name]}</p>
    <Link href="/" className="button button-primary" data-testid={`link-return-from-${name}`}><ArrowLeft size={14} /> Return to Web workspace</Link>
  </div></main>;
}