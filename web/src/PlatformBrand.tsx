import logo from './assets/platform-logo.png'

export const platformName = '图腾数安文件管理平台'

export function PlatformBrand() {
  return <>
    <img className="brand-logo" src={logo} width={794} height={236} alt="" />
    <span>{platformName}</span>
  </>
}
