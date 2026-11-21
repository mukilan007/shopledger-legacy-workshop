var config = require('../config');
var pricing = require('./pricing');
var gst = require('./tax');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function savedAmount(value, fallback) {
  if (typeof value === 'string' && value.trim()) value = Number(value);
  return Number.isFinite(value) ? pricing.round2(value) : fallback;
}

function computeFigures(order, useBilledDiscount) {
  var items = order.items || [];
  var totals = pricing.computeTotals(items, order.coupon);
  var subtotal = totals.subtotal;
  var discount = totals.discount;
  if (useBilledDiscount) {
    var savedDiscount = savedAmount(order.discount, null);
    var savedTax = savedAmount(order.tax, null);
    var savedTotal = savedAmount(order.total, null);
    if (savedDiscount === null && savedTax !== null && savedTotal !== null) {
      var billedSubtotal = savedAmount(order.subtotal, subtotal);
      var impliedDiscount = pricing.round2(billedSubtotal + savedTax - savedTotal);
      if (impliedDiscount >= 0 && impliedDiscount <= billedSubtotal) savedDiscount = impliedDiscount;
    }
    if (savedDiscount !== null) discount = savedDiscount;
  }
  var discountRatio = subtotal > 0 ? discount / subtotal : 0;
  var reconstructedTax = 0;

  var rows = totals.lines.map(function (line, index) {
    var item = items[index];
    var lineTax = line.tax;
    if (discount !== totals.discount) {
      var lineDiscount = pricing.round2(line.gross * discountRatio);
      var taxable = pricing.round2(line.gross - lineDiscount);
      lineTax = pricing.round2(taxable * gst.getRateForItem(item));
    }
    reconstructedTax = pricing.round2(reconstructedTax + lineTax);

    return {
      name: item.name,
      sku: item.sku || '-',
      hsn: item.hsn || '-',
      qty: item.qty,
      price: item.price,
      gstPercent: line.gstPercent,
      line: line.gross,
      lineTax: lineTax,
      estimatedGst: !Number.isFinite(item.gstRate)
    };
  });

  var split = gst.splitCgstSgst(reconstructedTax);
  return {
    subtotal: subtotal,
    discount: discount,
    tax: reconstructedTax,
    cgst: split.cgst,
    sgst: split.sgst,
    total: pricing.round2(subtotal - discount + reconstructedTax),
    rows: rows
  };
}

// Recalculate under current rules so reconciliation can check the ledger independently.
exports.computeInvoiceFigures = function (order) {
  return computeFigures(order, false);
};

exports.render = function (order) {
  var calc = computeFigures(order, true);
  var billedSubtotal = savedAmount(order.subtotal, calc.subtotal);
  var billedDiscount = savedAmount(order.discount, null);
  var billedTax = savedAmount(order.tax, null);
  var billedTotal = savedAmount(order.total, null);
  if (billedTax === null && billedDiscount !== null && billedTotal !== null) {
    var impliedTax = pricing.round2(billedTotal - billedSubtotal + billedDiscount);
    if (impliedTax >= 0) billedTax = impliedTax;
  }

  var estimatedTax = billedTax === null;
  var gstBreakdownAvailable = estimatedTax || billedTax === calc.tax;
  if (billedDiscount === null) billedDiscount = calc.discount;
  if (estimatedTax) billedTax = calc.tax;
  var printedSum = pricing.round2(billedSubtotal - billedDiscount + billedTax);
  if (billedTotal === null) billedTotal = printedSum;
  var rowsHtml = '';

  calc.rows.forEach(function (r, idx) {
    var lineRate = gstBreakdownAvailable || !r.estimatedGst ? r.gstPercent + '%' : '—';
    var lineTax = gstBreakdownAvailable ? '₹' + r.lineTax.toFixed(2) : '—';
    if (gstBreakdownAvailable && (estimatedTax || r.estimatedGst)) lineTax += ' *';

    rowsHtml += '<tr>' +
      '<td>' + (idx + 1) + '</td>' +
      '<td><strong>' + esc(r.name) + '</strong><div style="font-size:11px;color:#64748b">SKU: ' + esc(r.sku) + '</div></td>' +
      '<td>' + esc(r.hsn) + '</td>' +
      '<td class="r">' + r.qty + '</td>' +
      '<td class="r">₹' + r.price.toFixed(2) + '</td>' +
      '<td class="r">' + lineRate + '</td>' +
      '<td class="r">' + lineTax + '</td>' +
      '<td class="r"><strong>₹' + r.line.toFixed(2) + '</strong></td>' +
      '</tr>';
  });

  var estimatedGstNote = gstBreakdownAvailable && calc.rows.some(function (row) {
    return estimatedTax || row.estimatedGst;
  }) ? '<p class="meta">* Estimated line GST uses current GST settings.</p>' : '';

  var notes = [];
  if (calc.subtotal !== billedSubtotal) {
    notes.push('The items add up to ₹' + calc.subtotal.toFixed(2) +
      '. The billed subtotal was ₹' + billedSubtotal.toFixed(2) + '.');
  }
  if (!gstBreakdownAvailable) {
    notes.push('The original line GST breakdown could not be reconstructed from the saved order. The total GST shown is the amount billed.');
  }
  if (printedSum !== billedTotal) {
    notes.push('The printed amounts add up to ₹' + printedSum.toFixed(2) +
      '. The amount billed was ₹' + billedTotal.toFixed(2) + '.');
  } else if (gstBreakdownAvailable && calc.total !== billedTotal) {
    notes.push('The recalculated total (₹' + calc.total.toFixed(2) +
      ') differs from the amount billed (₹' + billedTotal.toFixed(2) + ').');
  }
  var reconciliationNotice = notes.length ? '<div class="warn-box">' +
    '<strong>Accountant Reconciliation Notice:</strong> ' + notes.join(' ') + '</div>' : '';
  var gstLabel = estimatedTax ? 'Estimated GST' : 'Total GST';
  var discountLabel = order.coupon ? 'Coupon Discount (' + esc(order.coupon) + ')' : 'Discount';

  return '<!doctype html><html><head><meta charset="utf-8">' +
    '<title>Tax Invoice #' + order.id + ' - ' + esc(config.shop.name) + '</title>' +
    '<style>' +
    'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;background:#f1f5f9;color:#0f172a;margin:0;padding:32px 16px}' +
    '.sheet{max-width:780px;margin:0 auto;background:#fff;border:1px solid #cbd5e1;border-radius:8px;padding:32px;box-shadow:0 4px 12px rgba(15,23,42,0.06)}' +
    '.hdr{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #0f172a;padding-bottom:18px;margin-bottom:20px}' +
    '.shop-title{font-size:22px;font-weight:700;margin:0 0 4px 0;color:#0f172a}' +
    '.meta{font-size:13px;color:#475569;line-height:1.5}' +
    '.badge{display:inline-block;padding:4px 10px;border-radius:4px;font-size:11px;font-weight:700;text-transform:uppercase;background:#e2e8f0;color:#1e293b}' +
    '.info-grid{display:flex;justify-content:space-between;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:14px 18px;margin-bottom:20px;font-size:13px}' +
    'table{width:100%;border-collapse:collapse;font-size:13px;margin-bottom:20px}' +
    'th{background:#f1f5f9;color:#334155;font-weight:600;text-transform:uppercase;font-size:11px;letter-spacing:0.03em;padding:10px 8px;border-bottom:2px solid #cbd5e1;text-align:left}' +
    'td{padding:10px 8px;border-bottom:1px solid #e2e8f0;vertical-align:top}' +
    '.r{text-align:right}' +
    '.totals-wrap{display:flex;justify-content:flex-end}' +
    '.totals-table{width:320px;font-size:13px}' +
    '.totals-table td{padding:6px 8px;border-bottom:1px solid #f1f5f9}' +
    '.totals-table tr.grand td{font-size:16px;font-weight:700;border-top:2px solid #0f172a;border-bottom:none;padding-top:10px}' +
    '.warn-box{margin-top:20px;padding:12px 16px;background:#fef2f2;border:1px solid #fecaca;border-left:4px solid #dc2626;color:#991b1b;font-size:13px;border-radius:4px}' +
    '.actions{margin-top:24px;padding-top:16px;border-top:1px dashed #cbd5e1;display:flex;justify-content:space-between;align-items:center;font-size:12px;color:#64748b}' +
    '.btn-print{background:#0f172a;color:#fff;border:none;padding:8px 16px;border-radius:5px;cursor:pointer;font-size:13px;font-weight:600}' +
    '@media print{body{background:#fff;padding:0}.sheet{border:none;box-shadow:none;padding:0}.btn-print{display:none}}' +
    '</style></head><body>' +
    '<div class="sheet">' +
    '<div class="hdr">' +
    '<div><h1 class="shop-title">' + esc(config.shop.name) + '</h1>' +
    '<div class="meta">' + esc(config.shop.address) + '<br>Phone: ' + esc(config.shop.phone) + '<br><strong>GSTIN: ' + esc(config.shop.gstin) + '</strong> &middot; State: ' + esc(config.shop.stateCode) + '</div></div>' +
    '<div style="text-align:right"><span class="badge">Tax Invoice</span>' +
    '<h2 style="margin:8px 0 2px 0;font-size:18px">INV-' + order.id + '</h2>' +
    '<div class="meta">Date: ' + esc(order.date) + '<br>Status: ' + esc((order.status || 'completed').toUpperCase()) + '</div></div>' +
    '</div>' +
    '<div class="info-grid">' +
    '<div><strong>Billed To:</strong><br>' + esc(order.customer || 'Walk-in Customer') + '</div>' +
    '<div><strong>Payment Mode:</strong><br>' + esc((order.paymentMode || 'cash').toUpperCase()) + '</div>' +
    '<div><strong>Promo Applied:</strong><br>' + (order.coupon ? esc(order.coupon) : 'None') + '</div>' +
    '</div>' +
    '<table><thead><tr><th>#</th><th>Item Description</th><th>HSN</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">GST %</th><th class="r">GST Amt</th><th class="r">Line Gross</th></tr></thead>' +
    '<tbody>' + rowsHtml + '</tbody></table>' + estimatedGstNote +
    '<div class="totals-wrap"><table class="totals-table">' +
    '<tr><td>Gross Subtotal</td><td class="r">₹' + billedSubtotal.toFixed(2) + '</td></tr>' +
    '<tr><td>CGST + SGST (' + gstLabel + ')</td><td class="r">₹' + billedTax.toFixed(2) + '</td></tr>' +
    (billedDiscount ? '<tr><td>' + discountLabel + '</td><td class="r" style="color:#16a34a">-₹' + billedDiscount.toFixed(2) + '</td></tr>' : '') +
    '<tr class="grand"><td>Invoice Total</td><td class="r">₹' + billedTotal.toFixed(2) + '</td></tr>' +
    '</table></div>' +
    reconciliationNotice +
    '<div class="actions">' +
    '<span>Computer generated tax invoice &middot; Subject to Pune Jurisdiction</span>' +
    '<button class="btn-print" onclick="window.print()">Print Invoice</button>' +
    '</div>' +
    '</div></body></html>';
};
