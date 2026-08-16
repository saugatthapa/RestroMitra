import { z } from "zod";

export const PAYMENT_GATEWAYS = ["esewa", "khalti"] as const;
export type PaymentGateway = (typeof PAYMENT_GATEWAYS)[number];

export const paymentGatewayParamSchema = z.enum(PAYMENT_GATEWAYS);
