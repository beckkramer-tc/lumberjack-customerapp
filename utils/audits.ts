import mkdirp from 'mkdirp'
import puppeteer, { Page } from 'puppeteer'

import fs from 'fs'

import { AxePuppeteer } from '@axe-core/puppeteer'

import { APP_CONFIG, AUDIT_FOLDER, REPORT_ID, ROUTE_CONFIG } from './_constants'
import {
  FeatureAuditSummary,
  AuditResultsSummary,
  FeatureConfig,
  FeatureInfo,
  RouteAuditSummary,
  User
} from './_types'

import { Reports } from './reports'
import { Violations } from './Violations'
import { getUsers } from './settings'

const ReportUtils = new Reports()
const ViolationUtils = new Violations()

/**
 * Anything concerned with running the audit itself, from
 * directing puppetteer and axe to run diagnostics to cycling
 * through provided features and routes in order, is handled
 * with this class.
 *
 * @class Audits
 */
export class Audits {
  /**
   * Log in a user
   * 
   * @function
   * @param  {Page} page Puppeteer page
   * @param  {User} user Current user data
   * @returns {Promise<void>}
   */
  public userLogin = async (page: Page, user: User): Promise<void> => {
    console.log('Redirected to login screen. Logging in...')

    try {
      await page.click(APP_CONFIG.login.fields.username)
      await page.keyboard.type(user.email)

      await page.click(APP_CONFIG.login.fields.password)
      await page.keyboard.type(user.password)

      
      await page.click(APP_CONFIG.login.fields.submitButton),
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 5000 })

      return Promise.resolve()
    } catch (error) {
      console.log('Unable to login. To troubleshoot:')
      console.log(`- check the config for ${user.email} or`)
      console.log('- run Lumberjack with headless mode turned off')
      process.exit()
    }
  }

  /**
   * Check if current page is login page
   * 
   * @function
   * @param {string} currentPath Current route path
   * @param {string} loginPath Login path of application being audited
   * @param {Page} page Current page instance
   * @returns {boolean} Whether the current page is the login page
   */
  public isLoginPage = (
    currentPath: string,
    loginPath: string,
    page: Page
  ): boolean => {
    const currentUrl = page.url()
    const isAtLogin = currentUrl.includes(loginPath)
    const isScanningLoginPath = currentPath === loginPath

    return isAtLogin && !isScanningLoginPath
  }

  /**
   * Check if page loads content that is included in the App config's
   * error content entries.
   *
   * @function
   * @param {Page} page Puppeteer page
   * @param {string} currentPath Path being checked
   * @returns {boolean} Returns true if content is valid
   */
  public hasValidContent = async (
    page: Page,
    currentPath: string
  ): Promise<boolean> => {
    const { featureId, content } = APP_CONFIG.errors

    const is404 = ROUTE_CONFIG.features.some((feature: FeatureConfig) => {
      return feature.id === featureId && feature.paths.includes(currentPath)
    })

    if (is404) return true

    // info
    console.log('Checking route for error content...')

    const pageContent = await page.$eval('body', element => element.outerHTML)
    const results: boolean[] = content.map((error: string) => {
      if (pageContent.includes(error)) {
        // warning
        console.log(`Error Content Found: "${error}"`)
        return false
      }
      return true
    })

    const hasOnlyValidContent = !results.includes(false)

    if (!hasOnlyValidContent) {
      // info
      console.log('This route will be skipped.')
    }

    return hasOnlyValidContent
  }

  /**
   * Navigates the page to the given path
   *
   * @function
   * @param {string} currentPath Current path being checked
   * @param {Page} page Puppeteer page
   * @param {User} user Current user info
   */
  public loadUrl = async (
    currentPath: string,
    page: Page,
    user: User
  ): Promise<void> => {
    const destinationUrl = APP_CONFIG.root + currentPath

    await page
      .goto(destinationUrl, { waitUntil: 'networkidle2' })
      .catch(error => {
        // error
        console.log('Issue with initial route loading.')
        throw error
      })

    const isAtLogin = page.url().includes(APP_CONFIG.login.path)
    const isScanningLoginPath = currentPath === APP_CONFIG.login.path

    if (isAtLogin && !isScanningLoginPath) {
      await this.userLogin(page, user)
    }

    if (page.url() !== destinationUrl) {
      throw new Error(
        `Unable to go to ${destinationUrl}. Current URL is ${page.url()}.`
      )
    }
  }

  /**
   * Loads route and runs AxePuppeteer on it
   * 
   * @function
   * @param {Page} page Puppeteer page
   * @param {string} currentPath Current path being checked
   * @param {User} user Current user account information
   * @param {*} featureInfo This feature's data
   * @param {string} reportId Report ID
   * @param {boolean} [headless=true] Should tests run in headless mode?
   * @param {boolean} [takeScreenshots=false] Should screenshots be taken?
   * @returns {Promise<RouteAuditSummary>} Returns audit summary for this route
   */
  public runAxeOnPath = async (
    page: Page,
    currentPath: string,
    user: User,
    featureInfo: FeatureInfo,
    reportId: string,
    headless = true,
    takeScreenshots = false
  ): Promise<RouteAuditSummary> => {
    let completedAudit = false
    let numberOfViolations = 0

    // await page.setViewport({
    //   width: 1200,
    //   height: 1400,
    // })

    console.group(`\n Auditing ${currentPath}...`)

    try {
      await this.loadUrl(currentPath, page, user)
    } catch (error) {
      // error
      console.log('Problem loading route.\n')

      console.groupEnd()

      return {
        completedAudit,
        numberOfViolations,
        route: currentPath,
      }
    }

    const contentValid = await this.hasValidContent(page, currentPath)

    if (contentValid) {
      let violations: any = []

      await new AxePuppeteer(page)
        .analyze()
        .then(async (results: any) => {
          if (results.violations && results.violations.length) {
            numberOfViolations = results.violations.length

            console.log(`${numberOfViolations} violation(s) found.`)
            violations = results.violations
          } else if (
            results.violations.length === 0 &&
            results.passes.length > 0
          ) {
            console.log('No violations found!')
          }

          await ReportUtils.writeFeatureReport(
            currentPath,
            violations,
            featureInfo,
            reportId
          )

          completedAudit = true
        })
        .catch(async (error: string) => {
          await ReportUtils.writeFeatureReport(
            currentPath,
            violations,
            featureInfo,
            reportId,
            true
          )

          console.log(
            ' No results returned- there may be an issue with this audit.'
          )
          console.log(error)
        })
    }

    console.groupEnd()

    return {
      completedAudit,
      numberOfViolations,
      route: currentPath,
    }
  }

  /**
   * Inserts param values into a route
   * 
   * This currently only gets 1 param per path; should be rewritten to scale
   *
   * @function
   * @param {string} path Current path
   * @returns {string} Current path with param values in place
   */
  public pathWithParamAdded = (path: string): string | 'invalidPath' => {
    const pathArray = path.split(':')
    const arraySectionWithParam = pathArray[1].split('/')
    const pathParam = arraySectionWithParam[0]

    if (ROUTE_CONFIG.params[pathParam]) {

      const newPath = path.replace(`:${pathParam}`, ROUTE_CONFIG.params[pathParam])

      return newPath
    } else {
      return 'invalidPath'
    }
  }

  /**
   * Runs audit functions on a given feature's routes
   *
   * @function
   * @param {string} reportId Report ID
   * @param {Feature} feature Config data for this route or feature
   * @param {User[]} users All user data
   * @param {boolean} [headless=true] Should tests run in headless mode?
   * @param {boolean} [screenshot=false] Should screenshots be taken?
   * @returns {AuditResultsSummary} Full audit summary
   */
  public auditFeature = async (
    reportId: string,
    feature: FeatureConfig,
    users: User[],
    headless = true,
    screenshot = false
  ): Promise<AuditResultsSummary> => {
    // heading
    console.log(
      `\nAuditing ${feature.name} Routes (${feature.paths.length} total):`
    )

    const summary: AuditResultsSummary = {
      reportId: reportId,
      featureId: feature.id,
      results: [],
    }

    for (const user of users) {
      const userId = user.email
      const auditSummary: FeatureAuditSummary = {
        completedAudits: 0,
        totalAudits: 0,
        totalViolations: 0,
        routesValidated: [],
        routesNotValidated: [],
      }

      console.group(`\n Auditing as user ${userId}...`)

      const featureInfo = {
        name: feature.name,
        id: feature.id,
      }
      const browser = await puppeteer.launch({
        defaultViewport: null,
        headless: headless,
      })
      const page = await browser.newPage()

      await page.setBypassCSP(true)

      for (const path of feature.paths) {
        const auditPath = path.indexOf(':') > 0 ? this.pathWithParamAdded(path) : path

        if (auditPath !== 'invalidPath') {
          try {
            const auditStatus = await this.runAxeOnPath(
              page,
              auditPath,
              user,
              featureInfo,
              reportId,
              headless,
              screenshot
            )

            if (auditStatus.completedAudit) {
              auditSummary.completedAudits++
              auditSummary.routesValidated.push(auditStatus.route)
            } else {
              auditSummary.routesNotValidated.push(auditStatus.route)
            }

            auditSummary.totalAudits++
            auditSummary.totalViolations += auditStatus.numberOfViolations
          } catch (error) {
            console.log(error)
          }
        }
      }

      summary.results.push(auditSummary)

      await page.close()
      await browser.close()
      console.groupEnd()
    }

    return summary
  }

  /**
   * Run an audit on all selected features
   *
   * @function
   * @param {Feature[]} features - Features to audit
   * @param {boolean} [headless=true] - Should tests run in headless mode?
   * @param {boolean} [takeScreenshots=false] - Should screenshots be taken?
   */
  public runAudit = async (
    features: FeatureConfig[],
    headless = true,
    takeScreenshots = false
  ): Promise<void> => {
    const summary = []
    const reportId = REPORT_ID
    const users = await getUsers()

    mkdirp(`${AUDIT_FOLDER}/route-reports`)

    for (const feature of features) {
      try {
        const auditSummary = await this.auditFeature(
          reportId,
          feature,
          users,
          headless,
          takeScreenshots
        )

        summary.push(auditSummary)
      } catch (error) {
        console.log(error)
      }
    }

    let totalViolationsForAllFeatures = 0
    const validatedRoutes: string[] = []
    let notValidatedRoutes: string[] = []

    summary.forEach(feature => {
      feature.results.forEach(result => {
        const { routesValidated, totalViolations } = result

        totalViolationsForAllFeatures += totalViolations

        routesValidated.forEach((route: string) => {
          if (!validatedRoutes.includes(route)) {
            validatedRoutes.push(route)
          }
          if (!notValidatedRoutes.includes(route)) {
            notValidatedRoutes.push(route)
          }
        })
      })
    })

    // If a notValidatedRoutes entry is found in validatedRoutes,
    // that means another account that was checked had access to it,
    // and that route should be removed from the array
    notValidatedRoutes = notValidatedRoutes.filter(route => {
      return !validatedRoutes.includes(route)
    })

    // success
    console.log('\n Success! ')

    console.log(
      ` Completed audits on ${validatedRoutes.length +
        notValidatedRoutes.length} routes. ${totalViolationsForAllFeatures} violations found.`
    )

    mkdirp(`${AUDIT_FOLDER}/summaries`)

    const routeSummary = await ViolationUtils.getRouteData(reportId)
    const featureSummary = await ViolationUtils.getFeatureSummariesByReportId(reportId)

    try {
      fs.writeFileSync(
        `${AUDIT_FOLDER}/summaries/${reportId}.json`,
        JSON.stringify({
          reportId,
          totalViolationsForAllFeatures,
          routes: {
            notValidated: notValidatedRoutes,
            validated: validatedRoutes,
            ...routeSummary,
          },
          features: featureSummary.features,
        }),
        { encoding: 'utf-8', flag: 'w' }
      )
    } catch (error) {
      if (error) {
        console.log('There was an issue writing the report.')
      } else {
        console.log('Report created.')
      }
    }

    if (notValidatedRoutes.length) {
      console.log('\nThe following routes were not validated:')

      notValidatedRoutes.forEach(route => {
        console.log(`- ${route}`)
      })
    }
  }
}
