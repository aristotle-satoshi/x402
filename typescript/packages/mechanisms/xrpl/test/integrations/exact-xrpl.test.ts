import { describe, expect, it, vi } from "vitest";
import { Wallet, decode } from "xrpl";
import { ExactXrplScheme as ExactXrplClientScheme } from "../../src/exact/client/scheme";
import { ExactXrplScheme as ExactXrplFacilitatorScheme } from "../../src/exact/facilitator/scheme";
import { ExactXrplScheme as ExactXrplServerScheme } from "../../src/exact/server/scheme";
import {
  TF_NO_RIPPLE_DIRECT,
  buildFacilitatorAttributionMemos,
  createXrplWalletSigner,
  invoiceIdToInvoiceIdField,
} from "../../src";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import type { Payment } from "xrpl";

const payerWallet = Wallet.fromSeed("sEdTM1uX8pu2do5XvTnutH6HsouMaM2");
const invoiceId = "INV-2026-XRPL-SETTLE";
const issuer = "rL4JcsJfvkYYAqNhjZ7Gvkh14eF7GXRh3q";
const sourceTag = 804_681_468;
const facilitatorProof = "0123456789abcdef".repeat(4);

const requirements: PaymentRequirements = {
  scheme: "exact",
  network: "xrpl:1",
  asset: "XRP",
  amount: "1000000",
  payTo: "rGsd42GGEq1tJBPQ3Aoj9iyePZbxiX5Nrv",
  maxTimeoutSeconds: 60,
  extra: { areFeesSponsored: false, invoiceId },
};

const crossCurrencyRequirements: PaymentRequirements = {
  ...requirements,
  asset: "USD",
  amount: "10.5",
  extra: { ...requirements.extra, issuer, crossCurrency: true },
};

const combinedIouRequirements: PaymentRequirements = {
  ...crossCurrencyRequirements,
  extra: {
    ...crossCurrencyRequirements.extra,
    sourceTag,
    facilitatorProof,
  },
};

const combinedXrpRequirements: PaymentRequirements = {
  ...requirements,
  extra: {
    ...requirements.extra,
    crossCurrency: true,
    sourceTag,
  },
};

function payload(): PaymentPayload {
  const tx: Payment = {
    TransactionType: "Payment",
    Account: payerWallet.classicAddress,
    Destination: requirements.payTo,
    Amount: requirements.amount,
    Fee: "12",
    Sequence: 1,
    LastLedgerSequence: 1_000,
    InvoiceID: invoiceIdToInvoiceIdField(invoiceId),
  };

  return {
    x402Version: 2,
    accepted: requirements,
    payload: { signedTxBlob: payerWallet.sign(tx).tx_blob },
  };
}

describe("ExactXrplScheme settlement", () => {
  it("settles a validated tesSUCCESS transaction", async () => {
    const submitSignedTransaction = vi.fn().mockResolvedValue({
      hash: "A".repeat(64),
      validated: true,
      resultCode: "tesSUCCESS",
    });
    const facilitator = new ExactXrplFacilitatorScheme({
      getCurrentLedgerIndex: async () => 990,
      getAccountSequence: async () => 1,
      getAccountAuthorization: async () => ({ isMasterKeyDisabled: false }),
      submitSignedTransaction,
      simulateSignedTransaction: async () => ({ engineResult: "tesSUCCESS" }),
    });

    const result = await facilitator.settle(payload(), requirements);

    expect(result).toMatchObject({
      success: true,
      transaction: "A".repeat(64),
      network: "xrpl:1",
      payer: payerWallet.classicAddress,
    });
    expect(submitSignedTransaction).toHaveBeenCalledOnce();
  });

  it("settles an exact cross-currency payment with matching delivery metadata", async () => {
    const submitSignedTransaction = vi.fn().mockResolvedValue({
      hash: "D".repeat(64),
      validated: true,
      resultCode: "tesSUCCESS",
      deliveredAmount: { currency: "USD", issuer, value: "10.50" },
    });
    const facilitator = new ExactXrplFacilitatorScheme({
      getCurrentLedgerIndex: async () => 990,
      getAccountSequence: async () => 1,
      getAccountAuthorization: async () => ({ isMasterKeyDisabled: false }),
      submitSignedTransaction,
      simulateSignedTransaction: async () => ({
        engineResult: "tesSUCCESS",
        deliveredAmount: { currency: "USD", issuer, value: "10.50" },
      }),
    });
    const server = new ExactXrplServerScheme();
    const enhancedRequirements = await server.enhancePaymentRequirements(
      crossCurrencyRequirements,
      {
        x402Version: 2,
        scheme: "exact",
        network: "xrpl:1",
        extra: facilitator.getExtra("xrpl:1"),
      },
      [],
    );
    const client = new ExactXrplClientScheme(createXrplWalletSigner(payerWallet), {
      preparePaymentTransaction: async transaction => ({
        ...transaction,
        SendMax: "25000000",
        Fee: "12",
        Sequence: 1,
        LastLedgerSequence: 1_000,
      }),
    });
    const generated = await client.createPaymentPayload(2, enhancedRequirements);
    const generatedPayload: PaymentPayload = {
      x402Version: generated.x402Version,
      accepted: enhancedRequirements,
      payload: generated.payload,
    };

    const result = await facilitator.settle(generatedPayload, enhancedRequirements);

    expect(result).toMatchObject({
      success: true,
      transaction: "D".repeat(64),
      payer: payerWallet.classicAddress,
    });
    expect(submitSignedTransaction).toHaveBeenCalledOnce();
  });

  it("combines cross-currency, attribution Memo, and InvoiceID with the default path", async () => {
    const deliveredAmount = { currency: "USD", issuer, value: "10.49999999999999" };
    const facilitator = new ExactXrplFacilitatorScheme({
      getCurrentLedgerIndex: async () => 990,
      getAccountSequence: async () => 1,
      getAccountAuthorization: async () => ({ isMasterKeyDisabled: false }),
      simulateSignedTransaction: async () => ({ engineResult: "tesSUCCESS", deliveredAmount }),
      submitSignedTransaction: async () => ({
        hash: "E".repeat(64),
        validated: true,
        resultCode: "tesSUCCESS",
        deliveredAmount,
      }),
    });
    const features = (facilitator.getExtra("xrpl:1")?.features ?? {}) as Record<string, unknown>;
    expect(features).toEqual({
      crossCurrency: true,
      sourceTag: true,
      facilitatorProof: true,
    });

    const enhancedRequirements = await new ExactXrplServerScheme().enhancePaymentRequirements(
      combinedIouRequirements,
      {
        x402Version: 2,
        scheme: "exact",
        network: "xrpl:1",
        extra: facilitator.getExtra("xrpl:1"),
      },
      [],
    );
    const client = new ExactXrplClientScheme(createXrplWalletSigner(payerWallet), {
      preparePaymentTransaction: async transaction => ({
        ...transaction,
        SendMax: "25000000",
        Fee: "12",
        Sequence: 1,
        LastLedgerSequence: 1_000,
      }),
    });
    const generated = await client.createPaymentPayload(2, enhancedRequirements);
    const transaction = decode(String(generated.payload.signedTxBlob)) as Payment;
    expect(transaction).toMatchObject({
      SourceTag: sourceTag,
      InvoiceID: invoiceIdToInvoiceIdField(invoiceId),
      SendMax: "25000000",
    });
    expect(transaction.Memos).toEqual(
      buildFacilitatorAttributionMemos(sourceTag, facilitatorProof),
    );
    expect(transaction.Paths).toBeUndefined();

    const result = await facilitator.settle(
      {
        x402Version: generated.x402Version,
        accepted: enhancedRequirements,
        payload: generated.payload,
      },
      enhancedRequirements,
    );
    expect(result).toMatchObject({ success: true, transaction: "E".repeat(64) });
  });

  it("combines SourceTag-only attribution with cross-currency explicit paths", async () => {
    const deliveredAmount = requirements.amount;
    const facilitator = new ExactXrplFacilitatorScheme({
      getCurrentLedgerIndex: async () => 990,
      getAccountSequence: async () => 1,
      getAccountAuthorization: async () => ({ isMasterKeyDisabled: false }),
      simulateSignedTransaction: async () => ({ engineResult: "tesSUCCESS", deliveredAmount }),
      submitSignedTransaction: async () => ({
        hash: "F".repeat(64),
        validated: true,
        resultCode: "tesSUCCESS",
        deliveredAmount,
      }),
    });
    const enhancedRequirements = await new ExactXrplServerScheme().enhancePaymentRequirements(
      combinedXrpRequirements,
      {
        x402Version: 2,
        scheme: "exact",
        network: "xrpl:1",
        extra: facilitator.getExtra("xrpl:1"),
      },
      [],
    );
    const paths: NonNullable<Payment["Paths"]> = [[{ account: issuer }]];
    const sendMax = { currency: "USD", issuer, value: "20" };
    const client = new ExactXrplClientScheme(createXrplWalletSigner(payerWallet), {
      preparePaymentTransaction: async transaction => ({
        ...transaction,
        SendMax: sendMax,
        Paths: paths,
        Flags: TF_NO_RIPPLE_DIRECT,
        Fee: "12",
        Sequence: 1,
        LastLedgerSequence: 1_000,
      }),
    });
    const generated = await client.createPaymentPayload(2, enhancedRequirements);
    const transaction = decode(String(generated.payload.signedTxBlob)) as Payment;
    expect(transaction).toMatchObject({
      SourceTag: sourceTag,
      InvoiceID: invoiceIdToInvoiceIdField(invoiceId),
      SendMax: sendMax,
      Paths: paths,
    });
    expect(transaction.Memos).toBeUndefined();

    const result = await facilitator.settle(
      {
        x402Version: generated.x402Version,
        accepted: enhancedRequirements,
        payload: generated.payload,
      },
      enhancedRequirements,
    );
    expect(result).toMatchObject({ success: true, transaction: "F".repeat(64) });
  });

  it("fails settlement for a validated non-success result", async () => {
    const facilitator = new ExactXrplFacilitatorScheme({
      getCurrentLedgerIndex: async () => 990,
      getAccountSequence: async () => 1,
      getAccountAuthorization: async () => ({ isMasterKeyDisabled: false }),
      simulateSignedTransaction: async () => ({ engineResult: "tesSUCCESS" }),
      submitSignedTransaction: vi.fn().mockResolvedValue({
        hash: "B".repeat(64),
        validated: true,
        resultCode: "tecNO_DST",
      }),
    });

    const result = await facilitator.settle(payload(), requirements);

    expect(result).toMatchObject({
      success: false,
      transaction: "B".repeat(64),
      network: "xrpl:1",
      payer: payerWallet.classicAddress,
    });
    expect(result.errorReason).toContain("tecNO_DST");
  });
});
