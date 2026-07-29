import {
  EXECUTIVE_LIMITS,
  EXECUTIVE_THRESHOLDS,
  formatINR,
  getDaysWithoutPIAtPeriodEnd,
} from './executiveCockpitUtils.js'
import { toNumber } from './piIntelligenceUtils.js'

const makeAlert = ({ data = {}, message, severity = 'info', type }) => ({
  data,
  message,
  severity,
  type,
})

const declineSeverity = (percentage) =>
  percentage <= EXECUTIVE_THRESHOLDS.highDeclinePercentage ? 'high' : 'attention'

export const buildExecutiveAlerts = (cockpit) => {
  const alerts = []
  const kpis = cockpit?.kpis ?? {}
  const customerHighlights = cockpit?.customerHighlights ?? {}
  const productHighlights = cockpit?.productHighlights ?? {}
  const concentration = cockpit?.concentration ?? {}
  const status = cockpit?.status ?? {}
  const growthHighlights = cockpit?.growthHighlights ?? {}
  const activityHighlights = cockpit?.activityHighlights ?? {}
  const topCustomer = customerHighlights.topCustomer
  const topProduct = productHighlights.topProduct
  const topCustomerShare = toNumber(concentration.customer?.topCustomerShare)
  const topProductShare = toNumber(concentration.product?.topProductShare)
  const valueChange = kpis.monthlyValueChangePercentage
  const countChange = kpis.monthlyCountChangePercentage

  if (topCustomerShare >= EXECUTIVE_THRESHOLDS.highConcentrationPercentage) {
    alerts.push(
      makeAlert({
        data: {
          customer: topCustomer?.customerName ?? topCustomer?.name ?? '',
          sharePercentage: topCustomerShare,
        },
        message: `The top customer represents ${topCustomerShare}% of current-period PI value.`,
        severity: 'high',
        type: 'customer_concentration',
      }),
    )
  } else if (topCustomerShare >= EXECUTIVE_THRESHOLDS.moderateConcentrationPercentage) {
    alerts.push(
      makeAlert({
        data: {
          customer: topCustomer?.customerName ?? topCustomer?.name ?? '',
          sharePercentage: topCustomerShare,
        },
        message: `The top customer represents ${topCustomerShare}% of current-period PI value.`,
        severity: 'attention',
        type: 'customer_concentration',
      }),
    )
  }

  if (topProductShare >= EXECUTIVE_THRESHOLDS.productConcentrationPercentage) {
    alerts.push(
      makeAlert({
        data: {
          product: topProduct?.productDescription ?? topProduct?.productCode ?? '',
          sharePercentage: topProductShare,
        },
        message: `The top product represents ${topProductShare}% of current-period PI line value.`,
        severity: 'attention',
        type: 'product_concentration',
      }),
    )
  }

  if (toNumber(status.open?.percentage) === 100 && toNumber(status.open?.count) > 0) {
    alerts.push(
      makeAlert({
        data: {
          openCount: status.open.count,
          openValue: status.open.value,
        },
        message: 'All PIs in the selected period are currently open.',
        severity: 'attention',
        type: 'all_open_pi_status',
      }),
    )
  }

  if (toNumber(status.final?.count) === 0 && toNumber(kpis.currentPeriodPICount) > 0) {
    alerts.push(
      makeAlert({
        data: {
          currentPeriodPICount: kpis.currentPeriodPICount,
        },
        message: 'No final PIs are recorded in the selected period.',
        severity: 'attention',
        type: 'no_final_pi',
      }),
    )
  }

  if (valueChange !== null && valueChange <= EXECUTIVE_THRESHOLDS.attentionDeclinePercentage) {
    alerts.push(
      makeAlert({
        data: {
          changePercentage: valueChange,
        },
        message: `Monthly PI value is down by ${Math.abs(valueChange)}% versus the comparison period.`,
        severity: declineSeverity(valueChange),
        type: 'pi_value_decline',
      }),
    )
  }

  if (countChange !== null && countChange <= EXECUTIVE_THRESHOLDS.attentionDeclinePercentage) {
    alerts.push(
      makeAlert({
        data: {
          changePercentage: countChange,
        },
        message: `Monthly PI count is down by ${Math.abs(countChange)}% versus the comparison period.`,
        severity: declineSeverity(countChange),
        type: 'pi_count_decline',
      }),
    )
  }

  if (toNumber(activityHighlights.inactiveCount) > 0) {
    alerts.push(
      makeAlert({
        data: {
          count: activityHighlights.inactiveCount,
          days: EXECUTIVE_THRESHOLDS.customerInactivityDays,
        },
        message: `${activityHighlights.inactiveCount} customer(s) have no PI activity in the selected inactivity window.`,
        severity: 'attention',
        type: 'inactive_customer_activity',
      }),
    )
  }

  if (toNumber(activityHighlights.reactivatedCount) > 0) {
    alerts.push(
      makeAlert({
        data: {
          count: activityHighlights.reactivatedCount,
        },
        message: `${activityHighlights.reactivatedCount} reactivated customer PI activity record(s) were detected.`,
        severity: 'info',
        type: 'reactivated_customer_activity',
      }),
    )
  }

  if (toNumber(growthHighlights.newCustomerCount) > 0) {
    alerts.push(
      makeAlert({
        data: {
          count: growthHighlights.newCustomerCount,
        },
        message: `${growthHighlights.newCustomerCount} new customer PI activity record(s) were detected.`,
        severity: 'info',
        type: 'new_customer_activity',
      }),
    )
  }

  if (toNumber(kpis.todayPICount) === 0) {
    alerts.push(
      makeAlert({
        data: {
          date: cockpit?.today,
        },
        message: 'No PI activity is recorded today.',
        severity: 'info',
        type: 'no_pi_activity_today',
      }),
    )
  }

  const daysWithoutPI = getDaysWithoutPIAtPeriodEnd(cockpit?.trend, cockpit?.period?.endDate)

  if (daysWithoutPI >= 3) {
    alerts.push(
      makeAlert({
        data: {
          daysWithoutPI,
        },
        message: `No PI activity is recorded for ${daysWithoutPI} consecutive day(s) at the end of the selected period.`,
        severity: 'attention',
        type: 'consecutive_no_pi_activity',
      }),
    )
  }

  const largePIs = Array.isArray(cockpit?.largePIs) ? cockpit.largePIs : []

  largePIs.slice(0, 3).forEach((pi) => {
    alerts.push(
      makeAlert({
        data: {
          averagePIValue: kpis.averagePIValue,
          piNumber: pi.piNumber,
          value: pi.grandTotal,
        },
        message: `${pi.piNumber} has PI value ${formatINR(pi.grandTotal)}, at least ${EXECUTIVE_THRESHOLDS.largePIMultiple} times the selected-period average.`,
        severity: 'info',
        type: 'large_pi_value',
      }),
    )
  })

  return alerts.slice(0, EXECUTIVE_LIMITS.alertList)
}
