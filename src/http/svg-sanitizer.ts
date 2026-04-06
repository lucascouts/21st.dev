export function sanitizeSvg(raw: string): string {
  let result = raw;

  // 1. Remove <script>...</script> and self-closing <script/>
  result = result.replace(/<script[\s\S]*?<\/script>/gi, "");
  result = result.replace(/<script[^>]*\/>/gi, "");

  // 2. Remove event handler attributes (onclick, onload, etc.)
  result = result.replace(/\son\w+\s*=\s*"[^"]*"/gi, "");
  result = result.replace(/\son\w+\s*=\s*'[^']*'/gi, "");

  // 3. Remove <foreignObject>...</foreignObject>
  result = result.replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, "");

  // 4. Remove javascript: in href and xlink:href
  result = result.replace(/(href\s*=\s*["'])javascript:[^"']*/gi, "$1");
  result = result.replace(/(xlink:href\s*=\s*["'])javascript:[^"']*/gi, "$1");

  // 5. Remove <iframe>, <embed>, <object>
  result = result.replace(/<iframe[\s\S]*?<\/iframe>/gi, "");
  result = result.replace(/<iframe[^>]*\/>/gi, "");
  result = result.replace(/<embed[\s\S]*?<\/embed>/gi, "");
  result = result.replace(/<embed[^>]*\/>/gi, "");
  result = result.replace(/<object[\s\S]*?<\/object>/gi, "");
  result = result.replace(/<object[^>]*\/>/gi, "");

  // 6. Remove dangerous data: URIs
  result = result.replace(/(href\s*=\s*["'])data:text\/html[^"']*/gi, "$1");
  result = result.replace(/(href\s*=\s*["'])data:application\/javascript[^"']*/gi, "$1");
  result = result.replace(/(xlink:href\s*=\s*["'])data:text\/html[^"']*/gi, "$1");
  result = result.replace(/(xlink:href\s*=\s*["'])data:application\/javascript[^"']*/gi, "$1");

  return result;
}
