function decodeEntities(input) {
  return String(input || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, '\'')
    .replace(/&amp;/g, '&');
}

function extractTag(xml, tagName) {
  const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, 'i');
  const match = xml.match(regex);
  return match ? decodeEntities(match[1].trim()) : '';
}

function extractLinkHref(xml) {
  const match = xml.match(/<link[^>]*href="([^"]+)"[^>]*\/?>/i);
  return match ? decodeEntities(match[1].trim()) : '';
}

function parseEntries(xml) {
  const entries = [];
  const re = /<entry>([\s\S]*?)<\/entry>/gi;
  let match = re.exec(xml);
  while (match) {
    const block = match[1];
    entries.push({
      id: extractTag(block, 'id'),
      title: extractTag(block, 'title'),
      updated: extractTag(block, 'updated'),
      published: extractTag(block, 'published'),
      link: extractLinkHref(block),
      summary: extractTag(block, 'summary'),
      content: extractTag(block, 'content'),
      author_did: extractTag(block, 'agentpress:author_did') || extractTag(block, 'name'),
      blog_type: extractTag(block, 'agentpress:blog_type') || 'major',
      signature_present: extractTag(block, 'agentpress:signature_present') === 'true'
    });
    match = re.exec(xml);
  }
  return entries;
}

function parseAtom(xml) {
  const feedLevel = String(xml || '').replace(/<entry>[\s\S]*?<\/entry>/gi, '');
  return {
    id: extractTag(feedLevel, 'id'),
    title: extractTag(feedLevel, 'title'),
    updated: extractTag(feedLevel, 'updated'),
    entries: parseEntries(xml)
  };
}

module.exports = {
  parseAtom
};
