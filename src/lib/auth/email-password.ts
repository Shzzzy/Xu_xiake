/**
 * 本应用自有的邮箱密码登录能力（不走共享认证代理）。
 *
 * 手机号注册会转换为内部邮箱后复用该能力；用户名插件只在服务端负责手机号登录。
 */
export const emailAndPasswordEnabled = true;
