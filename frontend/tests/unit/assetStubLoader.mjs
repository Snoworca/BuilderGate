// Node module-customization hooks that stub non-JS assets (.css, images, fonts)
// so a Vite-built component graph can be imported by node:test. Vite handles these
// at bundle time; Node has no loader for them.
const STUBBED = /\.(css|scss|sass|less|svg|png|jpg|jpeg|gif|webp|woff2?|ttf|eot)(\?.*)?$/;

export async function resolve(specifier, context, nextResolve) {
  if (STUBBED.test(specifier)) {
    return { url: new URL('data:text/javascript,export default {};').href, shortCircuit: true, format: 'module' };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (STUBBED.test(url)) {
    return { format: 'module', source: 'export default {};', shortCircuit: true };
  }
  return nextLoad(url, context);
}
