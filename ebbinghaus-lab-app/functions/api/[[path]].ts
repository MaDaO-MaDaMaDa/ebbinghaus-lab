import app from '../../src/index';

export const onRequest = (context: any) => {
  return app.fetch(context.request, context.env, context);
};
