const express = require('express')
const router = express.Router()
const accountManager = require('../utils/account')
const { logger } = require('../utils/logger')
const { JwtDecode } = require('../utils/tools')
const { adminKeyVerify } = require('../middlewares/authorization')
const { deleteAccount, saveAccounts, refreshAccountToken } = require('../utils/setting')

/**
 * 获取所有账号（分页）
 * 
 * @param {number} page 页码
 * @param {number} pageSize 每页数量
 * @returns {Object} 账号列表
 */
router.get('/getAllAccounts', adminKeyVerify, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1
    const pageSize = parseInt(req.query.pageSize) || 1000
    const start = (page - 1) * pageSize

    // 获取所有账号键
    const allAccounts = accountManager.getAllAccountKeys()
    const total = allAccounts.length

    // 分页处理
    const paginatedAccounts = allAccounts.slice(start, start + pageSize)

    // 获取每个账号的详细信息
    const accounts = paginatedAccounts.map(account => {
      return {
        email: account.email,
        password: account.password,
        token: account.token,
        expires: account.expires
      }
    })

    res.json({
      total,
      page,
      pageSize,
      data: accounts
    })
  } catch (error) {
    logger.error('获取账号列表失败', 'ACCOUNT', '', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * POST /setAccount
 * 添加账号
 * 
 * @param {string} email 邮箱
 * @param {string} password 密码
 * @returns {Object} 账号信息
 */
router.post('/setAccount', adminKeyVerify, async (req, res) => {
  try {
    const { email, password } = req.body

    if (!email || !password) {
      return res.status(400).json({ error: '邮箱和密码不能为空' })
    }

    // 检查账号是否已存在
    const exists = accountManager.accountTokens.find(item => item.email === email)
    if (exists) {
      return res.status(409).json({ error: '账号已存在' })
    }

    const authToken = await accountManager.login(email, password)
    if (!authToken) {
      return res.status(401).json({ error: '登录失败' })
    }
    // 解析JWT
    const decoded = JwtDecode(authToken)
    const expires = decoded.exp

    const success = await saveAccounts(email, password, authToken, expires)

    if (success) {
      res.status(200).json({
        email,
        message: '账号创建成功'
      })
    } else {
      res.status(500).json({ error: '账号创建失败' })
    }
  } catch (error) {
    logger.error('创建账号失败', 'ACCOUNT', '', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * DELETE /deleteAccount
 * 删除账号
 * 
 * @param {string} email 邮箱
 * @returns {Object} 账号信息
 */
router.delete('/deleteAccount', adminKeyVerify, async (req, res) => {
  try {
    const { email } = req.body

    // 检查账号是否存在
    const exists = await accountManager.accountTokens.find(item => item.email === email)
    if (!exists) {
      return res.status(404).json({ error: '账号不存在' })
    }

    // 删除账号
    const success = await deleteAccount(email)

    if (success) {
      res.json({ message: '账号删除成功' })
    } else {
      res.status(500).json({ error: '账号删除失败' })
    }
  } catch (error) {
    logger.error('删除账号失败', 'ACCOUNT', '', error)
    res.status(500).json({ error: error.message })
  }
})


/**
 * POST /setAccounts
 * 批量添加账号（并行处理）
 *
 * @param {string} accounts 账号列表
 * @returns {Object} 添加结果统计
 */
router.post('/setAccounts', adminKeyVerify, async (req, res) => {
  try {
    let { accounts } = req.body
    if (!accounts) {
      return res.status(400).json({ error: '账号列表不能为空' })
    }

    accounts = accounts.replace(/[\r]/g, '\n')
    const accountList = accounts.split('\n').filter(item => item.trim() !== '')

    if (accountList.length === 0) {
      return res.status(400).json({ error: '没有有效的账号' })
    }

    // 解析账号列表
    const parsedAccounts = accountList.map(account => {
      const [email, password] = account.split(':')
      return { email: email?.trim(), password: password?.trim() }
    }).filter(acc => acc.email && acc.password)

    // 过滤已存在的账号
    const existingEmails = new Set(accountManager.getAllAccountKeys().map(acc => acc.email))
    const newAccounts = parsedAccounts.filter(acc => !existingEmails.has(acc.email))
    const skippedCount = parsedAccounts.length - newAccounts.length

    // 并行登录（限制并发数为5）
    const concurrencyLimit = 5
    const results = []

    for (let i = 0; i < newAccounts.length; i += concurrencyLimit) {
      const batch = newAccounts.slice(i, i + concurrencyLimit)
      const batchResults = await Promise.allSettled(
        batch.map(async ({ email, password }) => {
          const authToken = await accountManager.login(email, password)
          if (!authToken) {
            throw new Error(`${email} 登录失败`)
          }
          const decoded = JwtDecode(authToken)
          return { email, password, token: authToken, expires: decoded.exp }
        })
      )
      // 记录每个结果对应的邮箱
      batchResults.forEach((result, idx) => {
        results.push({ ...result, email: batch[idx].email })
      })
    }

    // 统计结果并保存成功的账号
    let successCount = 0
    let failedCount = 0
    const failedEmails = []

    for (const result of results) {
      if (result.status === 'fulfilled') {
        const { email, password, token, expires } = result.value
        const saved = await accountManager.addAccountWithToken(email, password, token, expires)
        if (saved) {
          successCount++
        } else {
          failedCount++
          failedEmails.push(email)
        }
      } else {
        failedCount++
        failedEmails.push(result.email)
      }
    }

    res.json({
      message: '批量添加完成',
      total: parsedAccounts.length,
      success: successCount,
      failed: failedCount,
      skipped: skippedCount,
      failedEmails: failedEmails.slice(0, 10) // 最多返回10个失败邮箱
    })
  } catch (error) {
    logger.error('批量创建账号失败', 'ACCOUNT', '', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * POST /refreshAccount
 * 刷新单个账号的令牌
 *
 * @param {string} email 邮箱
 * @returns {Object} 刷新结果
 */
router.post('/refreshAccount', adminKeyVerify, async (req, res) => {
  try {
    const { email } = req.body

    if (!email) {
      return res.status(400).json({ error: '邮箱不能为空' })
    }

    // 检查账号是否存在
    const exists = accountManager.accountTokens.find(item => item.email === email)
    if (!exists) {
      return res.status(404).json({ error: '账号不存在' })
    }

    // 刷新账号令牌
    const success = await accountManager.refreshAccountToken(email)

    if (success) {
      res.json({
        message: '账号令牌刷新成功',
        email: email
      })
    } else {
      res.status(500).json({ error: '账号令牌刷新失败' })
    }
  } catch (error) {
    logger.error('刷新账号令牌失败', 'ACCOUNT', '', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * POST /refreshAllAccounts
 * 刷新所有账号的令牌
 *
 * @param {number} thresholdHours 过期阈值（小时），默认24小时
 * @returns {Object} 刷新结果
 */
router.post('/refreshAllAccounts', adminKeyVerify, async (req, res) => {
  try {
    const { thresholdHours = 24 } = req.body

    // 执行批量刷新
    const refreshedCount = await accountManager.autoRefreshTokens(thresholdHours)

    res.json({
      message: '批量刷新完成',
      refreshedCount: refreshedCount,
      thresholdHours: thresholdHours
    })
  } catch (error) {
    logger.error('批量刷新账号令牌失败', 'ACCOUNT', '', error)
    res.status(500).json({ error: error.message })
  }
})

/**
 * POST /forceRefreshAllAccounts
 * 强制刷新所有账号的令牌（不管是否即将过期）
 *
 * @returns {Object} 刷新结果
 */
router.post('/forceRefreshAllAccounts', adminKeyVerify, async (req, res) => {
  try {
    // 强制刷新所有账号（设置阈值为很大的值，确保所有账号都会被刷新）
    const refreshedCount = await accountManager.autoRefreshTokens(8760) // 365天

    res.json({
      message: '强制刷新完成',
      refreshedCount: refreshedCount,
      totalAccounts: accountManager.getAllAccountKeys().length
    })
  } catch (error) {
    logger.error('强制刷新账号令牌失败', 'ACCOUNT', '', error)
    res.status(500).json({ error: error.message })
  }
})


module.exports = router