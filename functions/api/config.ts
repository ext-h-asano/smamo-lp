import { Env, jsonResponse } from "../_lib/stripe";

export const onRequestGet: PagesFunction<Env> = ({ env }) => {
  return jsonResponse({
    publishable_key: env.STRIPE_PUBLISHABLE_KEY,
  });
};
