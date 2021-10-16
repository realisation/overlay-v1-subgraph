import { Address, BigDecimal, BigInt, Bytes, ethereum, log } from "@graphprotocol/graph-ts"

import {
  FundingPaid,
  NewPrice,
  OverlayV1UniswapV3Market,
  OverlayV1UniswapV3Market__oiResult
} from "../generated/OverlayV1UniswapV3Market/OverlayV1UniswapV3Market"

import {
  OverlayV1OVLCollateral
} from "../generated/OverlayV1OVLCollateral/OverlayV1OVLCollateral"

import {
  countPricePoint,
  loadMarket,
  loadMarketManifest,
  loadMarketMonitor,
  loadPricePoint,
  morphd
} from "./utils"

import {
  Market,
  Position,
  PricePoint
} from "../generated/schema"

export function handleFundingPaid(event: FundingPaid): void { }

export function handleNewPrice(event: NewPrice): void {

  let number = countPricePoint(event.address)

  let pricePoint = loadPricePoint( event.address, number, "event") as PricePoint

  pricePoint.bid = event.params.bid
  pricePoint.ask = event.params.ask
  pricePoint.index = event.params.index

  pricePoint.save()

}

export function handleBlock(block: ethereum.Block): void {

  let now = block.timestamp

  let manifest = loadMarketManifest()

  let markets = manifest.markets 
  let compoundings = manifest.compoundings
  let updates = manifest.updates

  for (let i = 0; i < manifest.markets.length; i++) {

    let marketAddr = Address.fromByteArray(markets[i]) as Address
    let compounding = compoundings[i]
    let update = updates[i]

    let marketInstance = OverlayV1UniswapV3Market.bind(marketAddr)

    let oi = marketInstance.oi()
    let oiCap = marketInstance.oiCap()

    let market = loadMarket(marketAddr)

    market.oiLong = oi.value0
    market.oiLongShares = oi.value2
    market.oiLongShares = oi.value4

    market.oiShort = oi.value1
    market.oiShortShares = oi.value3
    market.oiShortQueued = oi.value5

    market.oiCap = oiCap


    if (update < now ) {

      let pricePoint = loadPricePoint( marketAddr, "none", "current" )

      market.currentPrice = pricePoint.id

      updates[i] = update.plus(market.updatePeriod)

    }

    if (now > compounding) {

      remasterLiquidations(market, oi)

      compoundings[i] = compounding.plus(market.compoundingPeriod)

    }

    market.save()

  }

  manifest.compoundings = compoundings
  manifest.updates = updates
  manifest.save()

}

function remasterLiquidations (
  market: Market,
  oi: OverlayV1UniswapV3Market__oiResult
): void {

  let marketAddr = Address.fromHexString(market.id) as Address

  let monitor = loadMarketMonitor(marketAddr)

  let positions = monitor.positions

  for (let j = 0; j < positions.length; j++) {

    let position = Position.load(positions[j]) as Position

    let collateralManager = OverlayV1OVLCollateral.bind(Address.fromByteArray(position.collateralManager) as Address)

    let marginMaintenance = morphd(collateralManager.marginMaintenance(marketAddr))

    let pricePoint = loadPricePoint( marketAddr, position.pricePoint, "liquidation" )

    if (pricePoint == null) continue

    setLiquidationPrice(
      position, 
      pricePoint as PricePoint, 
      oi, 
      marginMaintenance
    ) 

  }

}


function setLiquidationPrice (
  position: Position, 
  pricePoint: PricePoint,
  openInterest: OverlayV1UniswapV3Market__oiResult,
  marginMaintenance: BigDecimal
): void {

  let oi = position.isLong
    ? morphd(openInterest.value0)
    : morphd(openInterest.value1)
 
  let oiShares = position.isLong
    ? morphd(openInterest.value2)
    : morphd(openInterest.value3)

  let liquidationPrice = _liquidationPrice(
    position, 
    pricePoint,
    oi, 
    oiShares, 
    marginMaintenance
  )

  position.liquidationPrice = liquidationPrice

  position.save()

}

function _liquidationPrice (
  position: Position, 
  pricePoint: PricePoint,
  totalOi: BigDecimal, 
  totalOiShares: BigDecimal,
  marginMaintenance: BigDecimal
): BigDecimal {

  let entryPrice = position.isLong
    ? morphd(pricePoint.ask)
    : morphd(pricePoint.bid)

  let oiShares = morphd(position.oiShares)
  let cost = morphd(position.cost)
  let debt = morphd(position.debt)

  let oi = oiShares * totalOi / totalOiShares;
  let initialOi = cost + debt;

  let _oiFrame = ( ( initialOi * marginMaintenance ) + debt ) / oi

  let liquidationPrice = BigInt.fromI32(0).toBigDecimal()

  if (position.isLong) liquidationPrice = entryPrice * _oiFrame;
  else liquidationPrice = entryPrice * ( BigInt.fromI32(2).toBigDecimal() - _oiFrame );

  return liquidationPrice
            
}