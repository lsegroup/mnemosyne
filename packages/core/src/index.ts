export * from './schema.js';
export * from './embedder.js';
export * from './search-backend.js';
export * from './llm.js';
export * from './fuse.js';
export * from './graph.js';

/** Text a node contributes to both lexical and semantic indexes. */
export function indexableText(node: {
  title: string;
  body: string;
  components: string[];
  project: string;
}): string {
  return [node.title, node.project, node.components.join(' '), node.body].join('\n');
}
