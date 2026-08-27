"use client";

import { useEffect, useState } from "react";
import { apiGet, ApiError } from "@/lib/api-client";
import { formatNPR } from "@/lib/money";
import { PAYOUT_METHOD_LABELS, type PayoutMethod } from "@/lib/finance/payout-methods";

type PayslipData = {
  restaurant: {
    name: string;
    address: string | null;
    city: string | null;
    district: string | null;
    panVat: string | null;
    phone: string | null;
  };
  staff: { name: string; role: string; email: string | null };
  payment: {
    id: string;
    payPeriodLabel: string | null;
    periodStart: string | null;
    periodEnd: string | null;
    paymentMethod: PayoutMethod;
    note: string | null;
    paidAt: string;
    isVoided: boolean;
    attendanceMinutesSnapshot: number | null;
    attendanceDaysSnapshot: number | null;
  };
  totals: {
    netAmountInPaisa: number;
    deductions: Array<{ label: string; amountInPaisa: number }>;
    totalDeductionsInPaisa: number;
    grossAmountInPaisa: number;
  };
};

/**
 * Commercial completion pass — payslip generation. Deliberately a plain
 * receipt of amounts already recorded, not a payroll calculator: it shows
 * gross (derived), any itemized deductions the manager typed in when
 * paying, and net (the actual amount paid) — no statutory PF/SSF/TDS math
 * is computed anywhere here (see src/lib/payslip.ts's doc comment).
 *
 * Same Tailwind `print:` utility convention as OrderBillView/KotTicketView
 * (no styled-jsx — this project's other print views don't use it and it
 * isn't otherwise exercised in this codebase). Unlike the KOT ticket view,
 * this does NOT auto-trigger window.print() on load — a payslip is usually
 * opened to review or hand to an employee, not fired at a receipt printer
 * the instant an order is confirmed.
 */
export function PayslipView({ slug, paymentId }: { slug: string; paymentId: string }) {
  const [data, setData] = useState<PayslipData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiGet<PayslipData>(`/api/restaurants/${slug}/payroll/payments/${paymentId}/payslip`)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : "Couldn't load this payslip.");
      });
    return () => {
      cancelled = true;
    };
  }, [slug, paymentId]);

  if (error) {
    return <p className="p-6 text-sm text-red-700">{error}</p>;
  }

  if (!data) {
    return <p className="p-6 text-sm text-neutral-500">Loading payslip…</p>;
  }

  const { restaurant, staff, payment, totals } = data;
  const period =
    payment.periodStart && payment.periodEnd
      ? `${payment.periodStart} to ${payment.periodEnd}`
      : payment.payPeriodLabel || "—";
  const locationLine = [restaurant.address, restaurant.city, restaurant.district]
    .filter(Boolean)
    .join(", ");

  return (
    <div className="min-h-screen bg-neutral-100 px-4 py-6 print:bg-white print:p-0">
      <div className="mx-auto mb-4 flex max-w-xl justify-end print:hidden">
        <button
          onClick={() => window.print()}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800"
        >
          Print / Save as PDF
        </button>
      </div>

      <div className="mx-auto max-w-xl rounded-lg bg-white p-8 shadow-sm print:max-w-none print:rounded-none print:p-0 print:shadow-none">
        {payment.isVoided && (
          <div className="mb-5 rounded-md bg-red-100 py-2 text-center text-sm font-bold tracking-wide text-red-800">
            VOIDED — this payment was reversed
          </div>
        )}

        <header className="mb-5 flex items-start justify-between border-b-2 border-neutral-900 pb-4">
          <div>
            <div className="text-xl font-bold text-neutral-900">{restaurant.name}</div>
            {locationLine && <div className="mt-0.5 text-sm text-neutral-500">{locationLine}</div>}
            {restaurant.phone && <div className="mt-0.5 text-sm text-neutral-500">Phone: {restaurant.phone}</div>}
            {restaurant.panVat && (
              <div className="mt-0.5 text-sm text-neutral-500">PAN/VAT: {restaurant.panVat}</div>
            )}
          </div>
          <div className="text-2xl font-extrabold tracking-widest text-neutral-700">PAYSLIP</div>
        </header>

        <div className="mb-6 grid grid-cols-2 gap-x-6 gap-y-3">
          <div>
            <div className="text-[11px] uppercase tracking-wide text-neutral-400">Employee</div>
            <div className="mt-0.5 text-sm font-semibold text-neutral-900">{staff.name}</div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wide text-neutral-400">Role</div>
            <div className="mt-0.5 text-sm font-semibold text-neutral-900">{staff.role}</div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wide text-neutral-400">Pay period</div>
            <div className="mt-0.5 text-sm font-semibold text-neutral-900">{period}</div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wide text-neutral-400">Paid on</div>
            <div className="mt-0.5 text-sm font-semibold text-neutral-900">
              {new Date(payment.paidAt).toLocaleDateString()}
            </div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wide text-neutral-400">Payment method</div>
            <div className="mt-0.5 text-sm font-semibold text-neutral-900">
              {PAYOUT_METHOD_LABELS[payment.paymentMethod] ?? payment.paymentMethod}
            </div>
          </div>
          {(payment.attendanceDaysSnapshot !== null || payment.attendanceMinutesSnapshot !== null) && (
            <div>
              <div className="text-[11px] uppercase tracking-wide text-neutral-400">Attendance</div>
              <div className="mt-0.5 text-sm font-semibold text-neutral-900">
                {payment.attendanceDaysSnapshot !== null ? `${payment.attendanceDaysSnapshot} day(s)` : ""}
                {payment.attendanceDaysSnapshot !== null && payment.attendanceMinutesSnapshot !== null
                  ? " · "
                  : ""}
                {payment.attendanceMinutesSnapshot !== null
                  ? `${(payment.attendanceMinutesSnapshot / 60).toFixed(1)} hr(s)`
                  : ""}
              </div>
            </div>
          )}
        </div>

        <table className="w-full border-collapse text-sm">
          <tbody>
            <tr className="border-b border-neutral-200">
              <td className="py-2.5">Gross pay</td>
              <td className="py-2.5 text-right tabular-nums">{formatNPR(totals.grossAmountInPaisa)}</td>
            </tr>
            {totals.deductions.map((d, i) => (
              <tr key={i} className="border-b border-neutral-200 text-red-700">
                <td className="py-2.5">Less: {d.label}</td>
                <td className="py-2.5 text-right tabular-nums">−{formatNPR(d.amountInPaisa)}</td>
              </tr>
            ))}
            {totals.deductions.length === 0 && (
              <tr className="border-b border-neutral-200 text-neutral-400">
                <td className="py-2.5" colSpan={2}>
                  No deductions recorded for this payment
                </td>
              </tr>
            )}
            <tr className="text-base font-extrabold">
              <td className="py-2.5">Net pay</td>
              <td className="py-2.5 text-right tabular-nums">{formatNPR(totals.netAmountInPaisa)}</td>
            </tr>
          </tbody>
        </table>

        {payment.note && (
          <div className="mt-5 rounded-md bg-neutral-50 p-3">
            <div className="text-[11px] uppercase tracking-wide text-neutral-400">Note</div>
            <div className="mt-0.5 text-sm text-neutral-900">{payment.note}</div>
          </div>
        )}

        <footer className="mt-8 text-[11px] leading-relaxed text-neutral-400">
          This is a system-generated payslip. It reflects amounts recorded in RestroMitra at the
          time of payment and does not include any statutory tax/PF/SSF computation.
        </footer>
      </div>
    </div>
  );
}
