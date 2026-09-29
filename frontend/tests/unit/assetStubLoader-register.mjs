import { register } from 'node:module';

// The render tests call React's `act`, which only the development build exports. A shell that
// inherits NODE_ENV=production (the installed BuilderGate sets it on Windows) loads the
// production build instead, and every render test failed with "act is not a function".
if (process.env.NODE_ENV === 'production') process.env.NODE_ENV = 'test';

register('./assetStubLoader.mjs', import.meta.url);
