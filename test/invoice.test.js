const assert = require('node:assert/strict');
const test = require('node:test');
const invoice = require('../lib/invoice');
const pricing = require('../lib/pricing');
const reports = require('../lib/reports');

const tea = { id: 1, sku: 'TEA', name: 'Tea', hsn: '0902', price: 500, qty: 1 };

function bill(items, coupon = '') {
  const billed = pricing.computeTotals(items, coupon);
  const { subtotal, discount, tax, total } = billed;

  // Keep the same pricing fields the order route saves for invoice rendering.
  const order = { id: 1, date: '01/04/2022', items, coupon, subtotal, discount, tax, total };
  return { billed, order };
}

function amounts({ subtotal, discount, tax, cgst, sgst, total }) {
  return { subtotal, discount, tax, cgst, sgst, total };
}

test('an uncouponed 18% HSN line agrees with the invoice', () => {
  const { billed, order } = bill([tea]);
  const printed = invoice.computeInvoiceFigures(order);
  const expected = { subtotal: 500, discount: 0, tax: 90, cgst: 45, sgst: 45, total: 590 };

  assert.deepEqual(amounts(billed), expected);
  assert.deepEqual(amounts(printed), expected);
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);
});

test('invoice uses the billed 5% and 12% HSN rates and line taxes', () => {
  const items = [
    { id: 2, sku: 'RICE', name: 'Rice', hsn: '1006', price: 100, qty: 2 },
    { id: 3, sku: 'GHEE', name: 'Ghee', hsn: '0405', price: 300, qty: 1 }
  ];
  const { billed, order } = bill(items);
  const printed = invoice.computeInvoiceFigures(order);

  assert.deepEqual(amounts(billed), {
    subtotal: 500, discount: 0, tax: 46, cgst: 23, sgst: 23, total: 546
  });
  assert.deepEqual(billed.lines.map(({ gstPercent, tax }) => [gstPercent, tax]), [
    [5, 10], [12, 36]
  ]);
  assert.deepEqual(amounts(printed), amounts(billed));
  assert.deepEqual(printed.rows.map(({ gstPercent, lineTax }) => [gstPercent, lineTax]), [
    [5, 10], [12, 36]
  ]);

  const html = invoice.render(order);
  assert.match(html, /CGST \+ SGST \(Total GST\)<\/td><td[^>]*>₹46\.00/);
  assert.match(html, /Invoice Total<\/td><td[^>]*>₹546\.00/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice/);
});

test('invoice honours the percentage coupon cap and applies GST after the discount', () => {
  const { billed, order } = bill([{ ...tea, price: 1000, qty: 2 }], 'SAVE10');

  assert.deepEqual(amounts(billed), {
    subtotal: 2000, discount: 150, tax: 333, cgst: 166.5, sgst: 166.5, total: 2183
  });
  assert.deepEqual(amounts(invoice.computeInvoiceFigures(order)), amounts(billed));
});

test('flat coupons reduce the GST printed on the invoice', () => {
  const { billed, order } = bill([tea], 'FLAT50');

  assert.deepEqual(amounts(billed), {
    subtotal: 500, discount: 50, tax: 81, cgst: 40.5, sgst: 40.5, total: 531
  });
  assert.deepEqual(amounts(invoice.computeInvoiceFigures(order)), amounts(billed));
});

test('invoice uses checkout GST for zero and decimal rates on stored lines', () => {
  const items = [
    { ...tea, price: 100, gstRate: 0 },
    { id: 4, sku: 'COFFEE', name: 'Coffee', hsn: '0901', price: 100, qty: 1, gstRate: 0.05 }
  ];
  const { billed, order } = bill(items);
  const printed = invoice.computeInvoiceFigures(order);

  assert.deepEqual(billed.lines.map(({ gstPercent, tax }) => [gstPercent, tax]), [
    [0, 0], [5, 5]
  ]);
  assert.deepEqual(printed.rows.map(({ gstPercent, lineTax }) => [gstPercent, lineTax]), [
    [0, 0], [5, 5]
  ]);
  assert.equal(billed.total, 205);
  assert.equal(printed.total, 205);
});

test('invoice sums the rounded line taxes and uses the checkout CGST and SGST split', () => {
  const items = [
    { ...tea, price: 0.03 },
    { id: 4, sku: 'COFFEE', name: 'Coffee', hsn: '0901', price: 0.03, qty: 1 }
  ];
  const { billed, order } = bill(items);
  const printed = invoice.computeInvoiceFigures(order);

  assert.equal(billed.tax, 0.02);
  assert.equal(billed.total, 0.08);
  assert.deepEqual(printed.rows.map(({ lineTax }) => lineTax), [0.01, 0.01]);
  assert.equal(printed.tax, 0.02);
  assert.equal(printed.cgst, 0.01);
  assert.equal(printed.sgst, 0.01);
  assert.equal(printed.total, 0.08);
});

test('reconciliation matches both GST and total for an uncapped percentage discount', () => {
  const { order } = bill([{ ...tea, qty: 2 }], 'SAVE10');
  const report = reports.getGstReconciliation({ orders: [order] });
  const { ledgerTax, invoiceTax, ledgerTotal, invoiceTotal, delta, matched } = report.rows[0];

  assert.equal(report.totalChecked, 1);
  assert.equal(report.mismatchCount, 0);
  assert.equal(report.totalDelta, 0);
  assert.deepEqual({ ledgerTax, invoiceTax, ledgerTotal, invoiceTotal, delta, matched }, {
    ledgerTax: 162, invoiceTax: 162, ledgerTotal: 1062, invoiceTotal: 1062, delta: 0, matched: true
  });
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);
});

test('a mixed-HSN order with capped SAVE10 prints the GST and total billed at checkout', () => {
  const items = [
    { id: 2, sku: 'RICE', name: 'Rice', hsn: '1006', price: 500, qty: 2 },
    { id: 3, sku: 'GHEE', name: 'Ghee', hsn: '0405', price: 1000, qty: 1 }
  ];
  const { order } = bill(items, 'SAVE10');
  const printed = invoice.computeInvoiceFigures(order);

  assert.equal(order.tax, 157.25);
  assert.equal(order.total, 2007.25);
  assert.deepEqual({
    ...amounts(printed),
    lineGst: printed.rows.map(({ gstPercent, lineTax }) => [gstPercent, lineTax])
  }, {
    subtotal: 2000, discount: 150, tax: 157.25, cgst: 78.63, sgst: 78.62, total: 2007.25,
    lineGst: [[5, 46.25], [12, 111]]
  });

  const html = invoice.render(order);
  assert.match(html, /Invoice Total<\/td><td[^>]*>₹2007\.25/);
  assert.match(html, /CGST \+ SGST \(Total GST\)<\/td><td[^>]*>₹157\.25/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice/);
});

test('reprinting preserves the billed discount after the coupon expires', () => {
  const order = {
    id: 1,
    date: '01/04/2022',
    items: [{ ...tea, price: 1000 }],
    coupon: 'DIWALI20',
    subtotal: 1000,
    discount: 200,
    tax: 144,
    total: 944
  };

  const html = invoice.render(order);
  assert.match(html, /Coupon Discount \(DIWALI20\)<\/td><td[^>]*>-₹200\.00/);
  assert.match(html, /GST\)<\/td><td[^>]*>₹144\.00/);
  assert.match(html, /Invoice Total<\/td><td[^>]*>₹944\.00/);
  assert.match(html, /₹144\.00 \*/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice/);
});

test('reprinting preserves billed GST and total when the recorded tax differs from current rates', () => {
  const order = {
    id: 1,
    date: '01/04/2022',
    items: [{ id: 2, sku: 'RICE', name: 'Rice', hsn: '1006', price: 500, qty: 1 }],
    coupon: '',
    subtotal: 500,
    discount: 0,
    tax: 90,
    total: 590
  };

  const report = reports.getGstReconciliation({ orders: [order] });
  assert.equal(report.mismatchCount, 1);
  assert.equal(report.rows[0].invoiceTax, 25);
  assert.equal(report.rows[0].invoiceTotal, 525);

  const html = invoice.render(order);
  assert.match(html, /<td[^>]*>—<\/td><td[^>]*>—<\/td>/);
  assert.match(html, /GST breakdown could not be reconstructed/);
  assert.match(html, /CGST \+ SGST \(Total GST\)<\/td><td[^>]*>₹90\.00/);
  assert.match(html, /Invoice Total<\/td><td[^>]*>₹590\.00/);
});

test('reconciliation still detects an inconsistent saved total', () => {
  const { order } = bill([tea]);
  order.total = 599;

  const report = reports.getGstReconciliation({ orders: [order] });
  assert.equal(report.mismatchCount, 1);
  assert.equal(report.rows[0].ledgerTotal, 599);
  assert.equal(report.rows[0].invoiceTotal, 590);
  assert.equal(report.rows[0].delta, -9);
  assert.equal(report.rows[0].matched, false);

  const html = invoice.render(order);
  assert.match(html, /Invoice Total<\/td><td[^>]*>₹599\.00/);
  assert.match(html, /Accountant Reconciliation Notice/);
});

test('line GST estimates are labelled even when the recomputed aggregate matches', () => {
  const { order } = bill([
    { id: 2, sku: 'RICE', name: 'Rice', hsn: '1006', price: 500, qty: 1, gstRate: 0.12 },
    { id: 3, sku: 'GHEE', name: 'Ghee', hsn: '0405', price: 500, qty: 1, gstRate: 0.05 }
  ]);
  order.items = order.items.map(({ gstRate, ...item }) => item);

  const html = invoice.render(order);
  assert.match(html, /Total GST\)<\/td><td[^>]*>₹85\.00/);
  assert.match(html, /₹25\.00 \*/);
  assert.match(html, /₹60\.00 \*/);
  assert.match(html, /Estimated line GST uses current GST settings/);
});

test('invoice warns when the printed amounts do not add up and line GST is unavailable', () => {
  const { order } = bill([tea]);
  order.subtotal = 510;
  order.tax = 95;

  const html = invoice.render(order);
  assert.match(html, /GST breakdown could not be reconstructed/);
  assert.match(html, /printed amounts add up to ₹605\.00/);
  assert.match(html, /Invoice Total<\/td><td[^>]*>₹590\.00/);
});

test('reconciliation flags a saved discount on a couponless order', () => {
  const { order } = bill([tea]);
  Object.assign(order, { discount: 50, tax: 81, total: 531 });

  const report = reports.getGstReconciliation({ orders: [order] });
  assert.equal(report.mismatchCount, 1);
  assert.equal(report.rows[0].invoiceDiscount, 0);
  assert.equal(report.rows[0].invoiceTotal, 590);

  const html = invoice.render(order);
  assert.match(html, /Discount<\/td><td[^>]*>-₹50\.00/);
  assert.match(html, /Invoice Total<\/td><td[^>]*>₹531\.00/);
});

test('invoice preserves a saved total represented as a numeric string', () => {
  const { order } = bill([tea]);
  order.total = '599.00';

  const html = invoice.render(order);
  assert.match(html, /Invoice Total<\/td><td[^>]*>₹599\.00/);
  assert.match(html, /Accountant Reconciliation Notice/);
});

test('reconciliation independently checks a recorded coupon discount', () => {
  const { order } = bill([tea]);
  order.coupon = 'FLAT50';

  const report = reports.getGstReconciliation({ orders: [order] });
  assert.equal(report.mismatchCount, 1);
  assert.equal(report.rows[0].invoiceDiscount, 50);
  assert.equal(report.rows[0].invoiceTotal, 531);
  assert.match(invoice.render(order), /Invoice Total<\/td><td[^>]*>₹590\.00/);
});

test('invoice flags a saved subtotal that differs from the item lines', () => {
  const { order } = bill([tea]);
  Object.assign(order, { subtotal: 550, discount: 50 });

  const html = invoice.render(order);
  assert.match(html, /items add up to ₹500\.00/);
  assert.match(html, /Gross Subtotal<\/td><td[^>]*>₹550\.00/);
});

test('invoice recovers missing billed GST from the saved billed amounts', () => {
  const { order } = bill([{ ...tea, hsn: '1006' }]);
  order.total = 590;
  delete order.tax;

  const html = invoice.render(order);
  assert.match(html, /Total GST\)<\/td><td[^>]*>₹90\.00/);
  assert.match(html, /GST breakdown could not be reconstructed/);
});

test('invoice labels GST as estimated if the billed aggregate cannot be recovered', () => {
  const { order } = bill([{ ...tea, hsn: '1006' }]);
  delete order.tax;
  delete order.total;

  const html = invoice.render(order);
  assert.match(html, /Estimated GST\)<\/td><td[^>]*>₹25\.00/);
});

test('invoice recovers billed GST using the item subtotal when the saved subtotal is missing', () => {
  const { order } = bill([{ ...tea, hsn: '1006' }]);
  order.total = 590;
  delete order.subtotal;
  delete order.tax;

  assert.match(invoice.render(order), /Total GST\)<\/td><td[^>]*>₹90\.00/);
});

test('invoice retains an explicitly saved rate when line tax is unavailable', () => {
  const { order } = bill([{ ...tea, gstRate: 0.05 }]);
  order.tax = 90;
  order.total = 590;

  assert.match(invoice.render(order), /<td[^>]*>5%<\/td><td[^>]*>—<\/td>/);
});

test('invoice recovers a missing historical discount before reconstructing GST', () => {
  const order = {
    id: 1,
    items: [{ ...tea, price: 1000 }],
    coupon: 'DIWALI20',
    subtotal: 1000,
    tax: 144,
    total: 944
  };

  const html = invoice.render(order);
  assert.match(html, /Coupon Discount \(DIWALI20\)<\/td><td[^>]*>-₹200\.00/);
  assert.match(html, /₹144\.00 \*/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice/);
});
