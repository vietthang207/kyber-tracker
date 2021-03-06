/* eslint no-multi-spaces: ["error", { exceptions: { "VariableDeclarator": true } }] */
const _ = require('lodash');
const async = require('async');
const util = require('util');
const BigNumber = require('bignumber.js');
const network = require('../../config/network');
const partners = network.partners
const Const = require('../common/Const');
const Utils = require('sota-core').load('util/Utils');
const BaseService = require('sota-core').load('service/BaseService');
const logger = require('sota-core').getLogger('TradeService');
const RedisCache = require('sota-core').load('cache/foundation/RedisCache');

const UtilsHelper = require('../common/Utils');

const CacheInfo = require('../../config/cache/info');

const THREE_MONTH_IN_SECOND = 60 * 60 * 24 * 90
module.exports = BaseService.extends({
  classname: 'TradeService',

  getTradesList: function (options, callback) {
    const KyberTradeModel = this.getModel('KyberTradeModel');

    let params = [];

    // const supportedTokenList = _.filter(global.TOKENS_BY_ADDR, (e) => {
    //   return UtilsHelper.shouldShowToken(e.address)
    // }).map(x => x.address).join('\',\'')

    // let whereClauses = `(taker_token_address IN ('${supportedTokenList}') AND maker_token_address IN ('${supportedTokenList}'))` + UtilsHelper.ignoreToken(['WETH']);
    let whereClauses = " ( 1=1 ) "

    if (options.address) {
      whereClauses += ' AND (taker_token_address = ? OR maker_token_address = ?)';
      params.push(options.address);
      params.push(options.address);
    }

    if (options.fromDate) {
      whereClauses += ' AND block_timestamp > ?';
      params.push(options.fromDate);
    }

    if (options.toDate) {
      whereClauses += ' AND block_timestamp < ?';
      params.push(options.toDate);
    }

    if(options.official){
      whereClauses += ` AND ( block_number < ? OR (source_official = 1 AND dest_official = 1))`;
      params.push(network.startPermissionlessReserveBlock);
    }

    if(options.reserve){
      whereClauses += ` AND ( (LOWER(source_reserve) = ?) OR (LOWER(dest_reserve) = ?))`;
      params.push(options.reserve.toLowerCase());
      params.push(options.reserve.toLowerCase());
    }

    const queryOptions = {
      where: whereClauses,
      params: params,
      ...(options.limit && {limit: options.limit}),
      ...(options.limit && options.page && {offset: options.page * options.limit}),
      orderBy: 'block_timestamp DESC'
    };

    async.auto({
      list: (next) => {
        KyberTradeModel.find(queryOptions, next);
      },
      count: (next) => {
        KyberTradeModel.count({
          where: whereClauses,
          params: params
        }, next);
      },
      volumeUsd: (next) => {
        KyberTradeModel.sum('volume_usd', {
          where: whereClauses,
          params: params,
        }, next);
      },
      volumeEth: (next) => {
        KyberTradeModel.sum('volume_eth', {
          where: whereClauses,
          params: params,
        }, next);
      },
      collectedFees: (next) => {
        KyberTradeModel.sum('collected_fees', {
          where: whereClauses,
          params: params,
        }, next);
      },
    }, (err, ret) => {
      if (err) {
        return callback(err);
      }

      return callback(null, {
        data: ret.list,
        pagination: {
          page: options.page,
          limit: options.limit,
          totalCount: ret.count,
          volumeUsd: ret.volumeUsd,
          volumeEth: ret.volumeEth,
          collectedFees: ret.collectedFees,
          maxPage: Math.ceil(ret.count / options.limit)
        }
      });
    });
  },

  getTradeDetails: function (tradeId, callback) {
    const KyberTradeModel = this.getModel('KyberTradeModel');
    KyberTradeModel.findOne(tradeId, callback);
  },

  getReservesList: function (options, callback){
    const adapter = this.getModel('KyberTradeModel').getSlaveAdapter();

    const nowInSeconds = Utils.nowInSeconds();
    const DAY_IN_SECONDS = 24 * 60 * 60;
    const dayAgo = nowInSeconds - DAY_IN_SECONDS;


    const makeSql = (side, callback) => {
      const sql = `select ${side}_reserve as address,
        sum(volume_eth) as eth,
        sum(volume_usd) as usd
      from kyber_trade
      where block_timestamp > ? AND block_timestamp < ? ${UtilsHelper.ignoreToken(['WETH'])}
      group by ${side}_reserve`;
      return adapter.execRaw(sql, [dayAgo, nowInSeconds], callback);
    };

    async.parallel({
      source: _next => makeSql('source', _next),
      dest: _next => makeSql('dest', _next),
    }, (err, ret) => {
      if (err) {
        return callback(err);
      }

      const takers = _.keyBy(ret.source, 'address');
      const makers = _.keyBy(ret.dest, 'address');

      const sumProp = (address, prop) => {
        let val = new BigNumber(0);
        const lowerAddr = address.toLowerCase()
        if (takers[lowerAddr]) val = val.plus((takers[lowerAddr][prop] || 0).toString());
        if (makers[lowerAddr]) val = val.plus((makers[lowerAddr][prop] || 0).toString());
        return val;
      };
      const reserves = [];

      Object.keys(global.NETWORK_RESERVES).forEach((r) => {
        const volumeUSD = sumProp(r, 'usd');
        const ethVolume = sumProp(r, 'eth');

        reserves.push({
          address: r,
          volumeUSD: volumeUSD.toNumber(),
          volumeETH: ethVolume.toNumber(),
          type: global.NETWORK_RESERVES[r]
        })
      })

      return callback(null, _.orderBy(reserves, ['volumeUSD' ], ['desc']));
    })
  },

  getReserveDetails: function (options, callback){
    async.parallel({
      currentListingTokens: _next => _next(null, this._currentList(options.reserveAddr)),
      tradedListTokens: _next => this._tradedList(options, _next)
    }, (err, results) => {
      if (err) {
        return callback(err);
      }
      const allReserveTokens = results.currentListingTokens
      results.tradedListTokens.map(t => {
        if(allReserveTokens[t.address]){
          allReserveTokens[t.address] = {...allReserveTokens[t.address], ...t}
        }
        // allReserveTokens[t.address] = {...(allReserveTokens[t.address] || global.TOKENS_BY_ADDR[t.address]), ...t}
      })


      return callback(null, _.orderBy(Object.values(allReserveTokens), ['listed', 'eth' ], ['asc', 'desc']))
    })
  },

  _currentList: function(reserveAddr){
    const returnObj = {}

    Object.keys(global.TOKENS_BY_ADDR).map(tokenAddr => {
      if(global.TOKENS_BY_ADDR[tokenAddr].reserves){
        if(UtilsHelper.shouldShowToken(tokenAddr) &&
          tokenAddr != network.ETH.address &&
          global.TOKENS_BY_ADDR[tokenAddr].reserves[reserveAddr.toLowerCase()]){
            returnObj[tokenAddr] = {...global.TOKENS_BY_ADDR[tokenAddr], listed: true, volumeUSD: 0, volumeETH: 0}
        }
      }
    })

    return returnObj
  },

  _tradedList: function(options, callback){
    const adapter = this.getModel('KyberTradeModel').getSlaveAdapter();

    const makeSql = (side, rside, callback) => {
      const sql = `select ${side}_token_address as address,
        IFNULL(sum(${side}_token_amount), 0) as token,
        IFNULL(sum(volume_eth),0) as eth,
        IFNULL(sum(volume_usd),0) as usd
      from kyber_trade
      where block_timestamp > ${options.fromDate} AND block_timestamp < ${options.toDate}
      and ${rside}_reserve = '${options.reserveAddr.toLowerCase()}'
      ${UtilsHelper.ignoreETH(side)}
      group by ${side}_token_address`;
      return adapter.execRaw(sql, [], callback);
    };

    async.parallel({
      maker: _next => makeSql('maker', 'dest', _next),
      taker: _next => makeSql('taker', 'source', _next)
    }, (err, ret) => {
      if (err) {
        return callback(err);
      }
      // const takers = _.keyBy(ret.taker, 'address');
      // const makers = _.keyBy(ret.maker, 'address');

      const toCollection = function(array) {
        return _.chain(array).groupBy('address')
              .map((v,i) => ({
                address: i.toLowerCase(),
                eth: _.sumBy(v, 'eth'),
                usd: _.sumBy(v, 'usd')
              })).value()
      }
      
      return callback(null, toCollection([...ret.taker, ...ret.maker])) 
    })

  },
  _reserveTrade: function(reserveAddr, callback){

  },
  // Use for token list page & top token chart
  getTopTokensList: function (options, callback) {

    const adapter = this.getModel('KyberTradeModel').getSlaveAdapter();

    const officialSql = options.official ? 
    ` AND ( block_number < ${network.startPermissionlessReserveBlock} OR (source_official = 1 AND dest_official = 1)) `
    :
    ''

    const makeSql = (side, obj) => {
      obj = obj || {};
      obj[side] = (callback) => {
        const sql = `select ${side}_token_address as address,
          sum(${side}_token_amount) as token,
          sum(volume_eth) as eth,
          sum(volume_usd) as usd
        from kyber_trade
        where block_timestamp > ? AND block_timestamp < ? ${UtilsHelper.ignoreToken(['WETH'])}
        ${officialSql}
        group by ${side}_token_address`;
        adapter.execRaw(sql, [options.fromDate, options.toDate], callback);
      };
      return obj;
    };

    async.auto(makeSql('maker', makeSql('taker')),
      (err, ret) => {
        if (err) {
          return callback(err);
        }

        const takers = _.keyBy(ret.taker, 'address');
        const makers = _.keyBy(ret.maker, 'address');

        const sumProp = (address, prop, decimals) => {
          let val = new BigNumber(0);
          if (takers[address]) val = val.plus((takers[address][prop] || 0).toString());
          if (makers[address]) val = val.plus((makers[address][prop] || 0).toString());

          if (decimals) {
            return val.div(Math.pow(10, decimals));
          }
          return val;
        };

        const supportedTokens = [];

        Object.keys(global.TOKENS_BY_ADDR).forEach((address) => {
          if (UtilsHelper.shouldShowToken(address) && UtilsHelper.filterOfficial(options.official, global.TOKENS_BY_ADDR[address])) {
            const token = global.TOKENS_BY_ADDR[address];

            const tokenVolume = sumProp(address, 'token', token.decimal);
            const volumeUSD = sumProp(address, 'usd');
            const ethVolume = sumProp(address, 'eth');
            supportedTokens.push({
              symbol: token.symbol,
              address: token.address,
              name: token.name,
              address: token.address,
              volumeToken: tokenVolume.toFormat(4).toString(),
              official: token.official || UtilsHelper.filterOfficial(true, token),
              volumeTokenNumber: tokenVolume.toNumber(),
              volumeUSD: volumeUSD.toNumber(),
              volumeETH: ethVolume.toFormat(4).toString(),
              volumeEthNumber: ethVolume.toNumber(),
              isNewToken: UtilsHelper.isNewToken(token.address),
              isDelisted: UtilsHelper.isDelisted(token.address)
            })

          }
        });

        return callback(null, _.orderBy(supportedTokens, ['volumeUSD' ], ['desc']));//.slice(0, 5));
      });

  },
  getTokensList: function (options, callback) {

    const adapter = this.getModel('KyberTradeModel').getSlaveAdapter();

    const officialSql = options.official ? 
    ` AND ( block_number < ${network.startPermissionlessReserveBlock} OR (source_official = 1 AND dest_official = 1))`
    :
    ''

    const makeSql = (side, obj) => {
      obj = obj || {};
      obj[side] = (callback) => {
        const sql = `select ${side}_token_address as address,
          sum(${side}_token_amount) as token,
          sum(volume_eth) as eth,
          sum(volume_usd) as usd
        from kyber_trade
        where block_timestamp > ? AND block_timestamp < ? ${UtilsHelper.ignoreToken(['WETH'])}
        ${officialSql}
        group by ${side}_token_address`;
        
        adapter.execRaw(sql, [options.fromDate, options.toDate], callback);
      };
      return obj;
    };

    async.auto(makeSql('maker', makeSql('taker')),
      (err, ret) => {
        if (err) {
          return callback(err);
        }
        const takers = _.keyBy(ret.taker, 'address');
        const makers = _.keyBy(ret.maker, 'address');

        const sumProp = (address, prop, decimals) => {
          let val = new BigNumber(0);
          if (takers[address]) val = val.plus((takers[address][prop] || 0).toString());
          if (makers[address]) val = val.plus((makers[address][prop] || 0).toString());

          if (decimals) {
            return val.div(Math.pow(10, decimals));
          }
          return val;
        };

        const supportedTokens = [];
        Object.keys(global.TOKENS_BY_ADDR).forEach((address) => {
          if (UtilsHelper.shouldShowToken(address, global.TOKENS_BY_ADDR, options.timeStamp) && UtilsHelper.filterOfficial(options.official, global.TOKENS_BY_ADDR[address])) {
            const token = global.TOKENS_BY_ADDR[address];

            const tokenVolume = sumProp(address, 'token', token.decimal);
            const volumeUSD = sumProp(address, 'usd');
            const ethVolume = sumProp(address, 'eth');

            supportedTokens.push({
              symbol: token.symbol,
              name: token.name,
              address: token.address,
              official: token.official || UtilsHelper.filterOfficial(true, token),
              volumeToken: tokenVolume.toNumber(),
              volumeTokenNumber: tokenVolume.toNumber(),
              volumeUSD: volumeUSD.toNumber(),
              volumeETH: ethVolume.toNumber(),
              volumeEthNumber: ethVolume.toNumber(),
              isNewToken: UtilsHelper.isNewToken(token.address),
              isDelisted: UtilsHelper.isDelisted(token.address)
            })

          }
        });

        return callback(null, _.orderBy(supportedTokens, ['isNewToken', 'isDelisted', 'volumeUSD' ], ['desc', 'desc', 'desc']));
      });

  },
  _aggregate: function (options, fromDate, toDate, callback) {
    const type = options.type || (!!options.groupBy ? "sumGroupBy" : "sum");
    const KyberTradeModel = this.getModel('KyberTradeModel');
    const sqlOptions = {
      where: 'block_timestamp > ? AND block_timestamp <= ?',
      params: [fromDate, toDate]
    }
    if (options.groupBy) {
      sqlOptions.groupBy = options.groupBy;
    }

    KyberTradeModel[type](options.column, sqlOptions, callback);
  },

  getPartners: function (fromDate, toDate, callback) {
    this._aggregate({
      column: 'volume_eth',
      groupBy: 'commission_receive_address'
    }, fromDate, toDate, callback)
    /*
    const KyberTradeModel = this.getModel('KyberTradeModel');
    KyberTradeModel.sumGroupBy('volume_eth', {
      where: 'block_timestamp > ? AND block_timestamp <= ?',
      params: [fromDate, toDate],
      groupBy: ['commission_receive_address']
    }, callback);
    */
  },

  getTraders: function (fromDate, toDate, callback) {
    this._aggregate({
      column: 'volume_usd',
      groupBy: 'taker_address'
    }, fromDate, toDate, callback)
  },

  getStats: function (fromDate, toDate, internal, callback) {
    const KyberTradeModel = this.getModel('KyberTradeModel');
    const funcs = {
      volumeUsd: (next) => {
        KyberTradeModel.sum('volume_usd', {
          where: `block_timestamp > ? AND block_timestamp <= ? ${UtilsHelper.ignoreToken(['WETH'])}`,
          params: [fromDate, toDate],
        }, next);
      },
      volumeEth: (next) => {
        KyberTradeModel.sum('volume_eth', {
          where: `block_timestamp > ? AND block_timestamp <= ? ${UtilsHelper.ignoreToken(['WETH'])}`,
          params: [fromDate, toDate],
        }, next);
      },
      tradeCount: (next) => {
        KyberTradeModel.count({
          where: 'block_timestamp > ? AND block_timestamp <= ?',
          params: [fromDate, toDate],
        }, next);
      }
    };

    if (internal) {
      funcs.burnAndTax = (next) => {
        KyberTradeModel.sum('burn_fees', {
          where: 'block_timestamp > ? AND block_timestamp <= ?',
          params: [fromDate, toDate],
        }, next);
      };
      funcs.commission = (next) => {
        KyberTradeModel.sum('commission', {
          where: 'block_timestamp > ? AND block_timestamp <= ?',
          params: [fromDate, toDate],
        }, next);
      };
      funcs.partnerCount = (next) => {
        KyberTradeModel.count({
          where: 'block_timestamp > ? AND block_timestamp <= ? AND commission_receive_address IS NOT NULL',
          params: [fromDate, toDate],
        }, next);
      };
      funcs.partnerVolumeEth = (next) => {
        KyberTradeModel.sum('volume_eth', {
          where: 'block_timestamp > ? AND block_timestamp <= ? AND commission_receive_address IS NOT NULL',
          params: [fromDate, toDate],
        }, next);
      };
    }

    async.auto(funcs, (err, ret) => {
      if (err) {
        return callback(err);
      }

      const burnAndTax = ret.burnAndTax ? new BigNumber(ret.burnAndTax.toString()).div(Math.pow(10, 18)) : undefined;
      const commission = ret.commission ? new BigNumber(ret.commission.toString()).div(Math.pow(10, 18)) : undefined;
      const result = {
        volumeUsd: ret.volumeUsd,
        volumeEth: ret.volumeEth,
        tradeCount: ret.tradeCount,
        burnAndTax: burnAndTax,
        partnerCount: ret.partnerCount,
        partnerVolumeEth: ret.partnerVolumeEth,
        commission: commission
      };

      return callback(null, result);
    });
  },

  // Use for topbar items
  getStats24h: function (params, callback) {
    let key = CacheInfo.Stats24h.key;
    if(params.official){
      key = 'official-' + key
    }

    const time_exprire = CacheInfo.Stats24h.TTL;
    // let params = {};
    params.time_exprire = time_exprire;
    params.key = key;
    RedisCache.getAsync(key, (err, ret) => {
      if (err) {
        logger.error(err)
      }
      if (ret) {
        return callback(null, JSON.parse(ret));
      }
      this._getStats24h(params, (err,ret_1)=>{
        if(err){
          logger.error(err)
          return callback(err)
        }
        RedisCache.setAsync(key, JSON.stringify(ret_1), time_exprire);
        callback(null, ret_1);
      });
    });
  },

  _getStats24h: function (options, callback) {
    const KyberTradeModel = this.getModel('KyberTradeModel');
    const BurnedFeeModel = this.getModel('BurnedFeeModel');
    const CMCService = this.getService('CMCService');
    const nowInSeconds = Utils.nowInSeconds();
    const DAY_IN_SECONDS = 24 * 60 * 60;

    let whereOffcial = ''
    if(options.official){
      whereOffcial += ` AND ( block_number < ${network.startPermissionlessReserveBlock} OR (source_official = 1 AND dest_official = 1))`;
    }
    async.auto({
      volumeUsd: (next) => {
        KyberTradeModel.sum('volume_usd', {
          where: `block_timestamp > ? ${UtilsHelper.ignoreToken(['WETH'])} ${whereOffcial}`,
          params: [nowInSeconds - DAY_IN_SECONDS],
        }, next);
      },
      ethMarketData: (next) => {
        CMCService.getCoingeckoTokenMaketData(network.ETH.address, next);
      },
      kncMarketData: (next) => {
        CMCService.getCoingeckoTokenMaketData(network.KNC.address, next);
      },
      /*
      volumeEth: (next) => {
        KyberTradeModel.sum('volume_eth', {
          where: 'block_timestamp > ?',
          params: [nowInSeconds - DAY_IN_SECONDS],
        }, next);
      },
      ethPrice: (next) => {
        CMCService.getCurrentPrice('ETH', next);
      },
      kncPrice: (next) => {
        CMCService.getCurrentPrice('KNC', next);
      },
      kncInfo: (next) => {
        CMCService.getCMCTokenInfo('KNC', next);
      },
      tradeCount: (next) => {
        KyberTradeModel.count({
          where: 'block_timestamp > ?',
          params: [nowInSeconds - DAY_IN_SECONDS]
        }, next);
      },
      */
      collectedFees: (next) => {
        KyberTradeModel.sum('collected_fees', {
          where: '1=1'
          //where: 'block_timestamp > ?',
          //params: [nowInSeconds - DAY_IN_SECONDS]
        }, next);
      },
      totalBurnedFee: (next) => {
        BurnedFeeModel.sum('amount', {
          where: '1=1'
        }, next);
      },
      /*
      feeToBurn: (next) => {
        KyberTradeModel.sum('burn_fees', {
          where: '1=1'
          // where: 'block_timestamp > ?',
          // params: [nowInSeconds - DAY_IN_SECONDS]
        }, next);
      },
      */
    }, (err, ret) => {
      if (err) {
        return callback(err);
      }

      const volumeInUSD = new BigNumber(ret.volumeUsd.toString());
      const KNCprice = new BigNumber(ret.kncMarketData && ret.kncMarketData.currentPrice && ret.kncMarketData.currentPrice.usd? ret.kncMarketData.currentPrice.usd.toString() : 0)
      const KNCchange24h = new BigNumber(ret.kncMarketData && ret.kncMarketData.priceChangePercentage24h ? ret.kncMarketData.priceChangePercentage24h.toString() : 0)

      const ETHprice = new BigNumber(ret.ethMarketData && ret.ethMarketData.currentPrice && ret.ethMarketData.currentPrice.usd ? ret.ethMarketData.currentPrice.usd.toString() : 0)
      const ETHchange24h = new BigNumber(ret.ethMarketData && ret.ethMarketData.priceChangePercentage24h ? ret.ethMarketData.priceChangePercentage24h.toString() : 0)
      //const volumeInETH = new BigNumber(ret.volumeEth.toString());
      //const feeInKNC = new BigNumber(ret.partnerFee.toString()).div(Math.pow(10, 18));
      //const feeInUSD = feeInKNC.times(ret.kncPrice);

      const burnedNoContract = network.preburntAmount || 0;
      const burnedWithContract = new BigNumber(ret.totalBurnedFee.toString()).div(Math.pow(10, 18));
      const actualBurnedFee = burnedWithContract.plus(burnedNoContract);
      //const feeToBurn = new BigNumber(ret.feeToBurn.toString()).div(Math.pow(10, 18));
      const collectedFees = new BigNumber(ret.collectedFees.toString()).div(Math.pow(10, 18));
      const result = {
        networkVolume: '$' + volumeInUSD.toFormat(2).toString(),
        //networkVolumeEth:  volumeInETH.toFormat(2).toString() + " ETH",
        collectedFees: collectedFees.toFormat(2).toString(),
        //tradeCount: ret.tradeCount,
        //kncInfo: ret.kncInfo,
        totalBurnedFee: actualBurnedFee.toFormat(2).toString(),
        // feeToBurn: feeToBurn.toFormat(2).toString()
        kncPrice: KNCprice.toFormat(4).toString(),
        kncChange24h: KNCchange24h.toFormat(2).toString(),

        ethPrice: ETHprice.toFormat(2).toString(),
        ethChange24h: ETHchange24h.toFormat(2).toString(),
      };
      return callback(null, result);
    });
  },

  _isTxHash: function (hash) {
    return /^0x([A-Fa-f0-9]{64})$/i.test(hash);
  },
  _isAddress: function (address) {
    return /^(0x)?[0-9a-f]{40}$/i.test(address)
  },

  search: function (options, callback) {
    const q = options.q.toLowerCase();
    const page = options.page || 0;
    const limit = options.limit || 20;
    const fromDate = options.fromDate;
    const toDate = options.toDate;

    const exportData = options.exportData;
    // Transaction hash
    if (this._isTxHash(q)) {
      this._searchByTxid(q, callback);
    }
    // Address
    else if (this._isAddress(q)) {
      this._searchByAddress(q, page, limit, fromDate, toDate, {exportData: exportData}, callback);
    }
    else {
      return callback(null, []);
    }
  },

  getPartnerDetail: function (options, callback) {
    let partnerId = options.partnerId.toLowerCase();
    const page = options.page || 0;
    const limit = options.limit || 20;
    const fromDate = options.fromDate
    const toDate = options.toDate

    const exportData = options.exportData


    if (!this._isAddress(partnerId)) {
      if (partners[partnerId]) partnerId = partners[partnerId]
      else return callback(`partnerID ${partnerId} not found`);
    }

    this._searchByAddress(partnerId, page, limit, fromDate, toDate, {
      exportData: exportData,
      partner: true
    }, callback);
  },

  _searchByTxid: function (txid, callback) {
    const KyberTradeModel = this.getModel('KyberTradeModel');
    KyberTradeModel.findOne({
      where: 'tx = ?',
      params: [txid]
    }, callback);
  },

  _searchByAddress: function (address, page, limit, fromDate, toDate, option, callback) {
    const KyberTradeModel = this.getModel('KyberTradeModel');
    let whereClauses = '';
    let params = [];

    if (option && option.partner) {
      whereClauses = 'LOWER(commission_receive_address) = ?';
      params = [address];
    } else {
      whereClauses = '(LOWER(maker_address) = ? OR LOWER(taker_address) = ?)';
      params = [address, address];
    }

    if (fromDate) {
      whereClauses += ' AND block_timestamp > ?';
      params.push(fromDate);
    }

    if (toDate) {
      whereClauses += ' AND block_timestamp < ?';
      params.push(toDate);
    }

    let findObj = {
      where: whereClauses,
      params: params,
      // limit: limit,
      // offset: page * limit,
      orderBy: 'block_timestamp DESC',
    }

    if(option.exportData){
      if(!fromDate || !toDate){
        return callback('Please select time range to export')
      } else {
        console.log("***************** time range", toDate, fromDate, toDate - fromDate)
        if(toDate - fromDate > THREE_MONTH_IN_SECOND) {
          return callback("Max time range is 3 months")
        }
      }
    } else {
      findObj.limit = limit
      findObj.offset = page * limit
    }

    async.auto({
      list: (next) => {
        KyberTradeModel.find(findObj, next);
      },
      count: (next) => {
        KyberTradeModel.count({
          where: whereClauses,
          params: params
        }, next);
      },
      volumeUsd: (next) => {
        KyberTradeModel.sum('volume_usd', {
          where: whereClauses,
          params: params,
        }, next);
      },
      volumeEth: (next) => {
        KyberTradeModel.sum('volume_eth', {
          where: whereClauses,
          params: params,
        }, next);
      },
      collectedFees: (next) => {
        KyberTradeModel.sum('collected_fees', {
          where: whereClauses,
          params: params,
        }, next);
      },
      commission: (next) => {
        if (!option || !option.partner) return next(null, 0)

        KyberTradeModel.sum('commission', {
          where: whereClauses,
          params: params,
        }, next);
      }
    }, (err, ret) => {
      if (err) {
        return callback(err);
      }

      return callback(null, {
        data: ret.list,
        pagination: {
          page: page,
          limit: limit,
          totalCount: ret.count,
          volumeUsd: ret.volumeUsd,
          volumeEth: ret.volumeEth,
          commission: ret.commission,
          collectedFees: ret.collectedFees,
          maxPage: Math.ceil(ret.count / limit)
        }
      });
    });
  },

  // Use for Volume charts
  getNetworkVolumes: function (options, callback) {
    const interval = options.interval || 'H1';
    const period = options.period || 'D7';
    const time_exprire = CacheInfo.NetworkVolumes.TTL;
    let key = `${CacheInfo.NetworkVolumes.key + period}-${interval}`;
    if (options.address) {
      key = options.address + '-' + key;
    }
    if (options.pair) {
      key = options.pair + '-' + key;
    }
    if (options.fromDate) {
      key = options.fromDate + '-' + key;
    }
    if (options.toDate) {
      key = options.toDate + '-' + key;
    }
    if(options.official){
      key = 'official-' + key
    }

    RedisCache.getAsync(key, (err, ret) => {
      if (err) {
        logger.error(err)
      }
      if (ret) {
        return callback(null, JSON.parse(ret));
      }
      options.interval = interval;
      options.period = period;
      options.key = key;
      this._getNetworkVolumes(options, (err, ret_1)=>{
        if(err){
          logger.info(err);
          return callback(err);
        }
        RedisCache.setAsync(key, JSON.stringify(ret_1), time_exprire);
        callback(null,ret_1)
      });

    });
  },

  _getNetworkVolumes: function (options, callback) {
    const KyberTradeModel = this.getModel('KyberTradeModel');
    const groupColumn = this._getGroupColumnByIntervalParam(options.interval);
    const [fromDate, toDate] = this._getRequestDatePeriods(options, options.period, options.interval);

    let whereClauses = `block_timestamp > ? AND block_timestamp <= ? ${UtilsHelper.ignoreToken(['WETH'])}`;
    let params = [fromDate, toDate];
    if (options.address) {
      whereClauses += ' AND (taker_token_address = ? OR maker_token_address = ?)';
      params.push(options.address.toLowerCase());
      params.push(options.address.toLowerCase());
    } else if(options.pair){
      const pairTokens = options.pair.split('_')
      whereClauses += ` AND ((taker_token_address = "${pairTokens[0].toLowerCase()}" AND maker_token_address = "${pairTokens[1].toLowerCase()}") OR (taker_token_address = "${pairTokens[1]}" AND maker_token_address = "${pairTokens[0]}"))`;
    }

    if(options.official){
      whereClauses += ` AND ( block_number < ? OR (source_official = 1 AND dest_official = 1))`;
      params.push(network.startPermissionlessReserveBlock);
    }

    async.auto({
      sum: (next) => {
        KyberTradeModel.sumGroupBy('volume_usd', {
          where: whereClauses,
          params: params,
          groupBy: [groupColumn],
        }, next);
      },
      sumEth: (next) => {
        KyberTradeModel.sumGroupBy('volume_eth', {
          where: whereClauses,
          params: params,
          groupBy: [groupColumn],
        }, next);
      },
      count: (next) => {
        KyberTradeModel.countGroupBy(groupColumn, {
          where: whereClauses,
          params: params,
          groupBy: [groupColumn]
        }, next);
      }
    }, (err, ret) => {
      if (err) {
        return callback(err);
      }

      const returnData = [];
      if (ret.sum.length) {

        for (let i = 0; i < ret.sum.length; i++) {
          returnData.push({
            daySeq: ret.sum[i].daySeq,
            hourSeq: ret.sum[i].hourSeq,
            sum: ret.sum[i].sum,
            sumEth: ret.sumEth[i].sum,
            count: ret.count[i].count
          })
        }
        const lastSeq = returnData[returnData.length - 1][this._convertSeqColumnName(groupColumn)];
        const nowSeq = parseInt(toDate / Const.CHART_INTERVAL[options.interval]);
        if (nowSeq > lastSeq) {
          const nullData = {
            [this._convertSeqColumnName(groupColumn)]: nowSeq,
            sum: 0,
            sumEth: 0,
            count: 0
          };
          returnData.push(nullData);
        }

      } else {
        const firstSeq = fromDate / Const.CHART_INTERVAL[options.interval];
        const nowSeq = toDate / Const.CHART_INTERVAL[options.interval];
        returnData.push({
          [this._convertSeqColumnName(groupColumn)]: firstSeq,
          sum: 0,
          sumEth: 0,
          count: 0
        });
        returnData.push({
          [this._convertSeqColumnName(groupColumn)]: nowSeq,
          sum: 0,
          sumEth: 0,
          count: 0
        });
      }
      return callback(null, returnData);
    });
  },

  getPairsVolumes: function (options, callback) {
    let key = `${CacheInfo.NetworkVolumes.key}${options.pairs}`;

    if (options.fromTime) {
      key = options.fromTime + '-' + key;
    }
    if (options.toTime) {
      key = options.toTime + '-' + key;
    }

    RedisCache.getAsync(key, (err, ret) => {
      if (err) {
        logger.error(err)
      }
      if (ret) {
        return callback(null, JSON.parse(ret));
      }

      let asyncPairs = {}
      options.pairsArray.map(p => {
        const tokens = p.split('_');
        asyncPairs[p] = (asyncCallback) => this._getPairVolume({
          tokens,
          fromTime: options.fromTime,
          toTime: options.toTime
        }, asyncCallback)
      })
      async.auto(asyncPairs, 10, (err, result)=>{
        if(err){
          pairs = {
            error:true,
            additional_data: err,
            reason:"server_error"
          }
        }
        callback(null, result);
      });
    })
  },

  _getPairVolume: function (options, callback){
    const KyberTradeModel = this.getModel('KyberTradeModel');
    let sqlQuery = ""
    let params = []
    if(options.fromTime){
      sqlQuery += `block_timestamp > ?`
      params.push(options.fromTime)
    }
    if(options.toTime){
      sqlQuery += `${sqlQuery && " AND "}block_timestamp < ?`
      params.push(options.toTime)
    }

    sqlQuery += `${sqlQuery && " AND "} ((maker_token_address = "${options.tokens[0].toLowerCase()}" AND taker_token_address = "${options.tokens[1].toLowerCase()}") OR (maker_token_address = "${options.tokens[1].toLowerCase()}" AND taker_token_address = "${options.tokens[0].toLowerCase()}"))`

    async.auto({
      volumeEth: (next) => {
        KyberTradeModel.sum('volume_eth', {
          where: sqlQuery,
          params: params,
        }, next);
      },
      volumeUsd: (next) => {
        KyberTradeModel.sum('volume_usd', {
          where: sqlQuery,
          params: params,
        }, next);
      }
    }, callback)
  },

  // Use for bot
  getTotalBurnedFees: function (callback) {
    const BurnedFeeModel = this.getModel('BurnedFeeModel');

    let key = CacheInfo.TotalBurnedFees.key;
    
    RedisCache.getAsync(key, (err, ret) => {
      if (err) {
        logger.error(err)
      }
      if (ret) {
        return callback(null, JSON.parse(ret));
      }
      async.auto({
        sum: (next) => {
          BurnedFeeModel.sum('amount', {
            where: '1 = 1'
          }, next);
        }
      }, (err, ret) => {
        if (err) {
          return callback(err);
        }

        const burnedNoContract = network.preburntAmount || 0;
        const sum = new BigNumber((ret.sum || 0).toString()).div(Math.pow(10, 18)).toNumber();

        const returnData = {burned: sum + burnedNoContract};
        RedisCache.setAsync(key, JSON.stringify(returnData), CacheInfo.TotalBurnedFees.TTL);
        return callback(null, returnData);
      });
    });
  },

  // Use for "Fees Burned" chart
  getBurnedFees: function (options, callback) {
    const BurnedFeeModel = this.getModel('BurnedFeeModel');
    const interval = options.interval || 'H1';
    const period = options.period || 'D7';

    let key = `${CacheInfo.BurnedFees.key + period}-${interval}`;

    RedisCache.getAsync(key, (err, ret) => {
      if (err) {
        logger.error(err)
      }
      if (ret) {
        return callback(null, JSON.parse(ret));
      }
      const groupColumn = this._getGroupColumnByIntervalParam(interval);
      const [fromDate, toDate] = this._getRequestDatePeriods(options, period, interval);

      let whereClauses = 'block_timestamp > ? AND block_timestamp <= ?';
      let params = [fromDate, toDate];

      async.auto({
        sum: (next) => {
          BurnedFeeModel.sumGroupBy('amount/1000000000000000000', {
            where: whereClauses,
            params: params,
            groupBy: [groupColumn],
          }, next);
        },
        pastSum: (next) => {
          BurnedFeeModel.sum('amount', {
            where: 'block_timestamp < ?',
            params: [fromDate]
          }, next);
        }
      }, (err, ret) => {
        if (err) {
          return callback(err);
        }

        const burnedNoContract = network.preburntAmount || 0;
        const pastSum = new BigNumber((ret.pastSum || 0).toString()).div(Math.pow(10, 18)).toNumber();
        let accuBurned = burnedNoContract + pastSum;
        const returnData = [];
        if (ret.sum.length) {
          const startSeq = parseInt(fromDate / Const.CHART_INTERVAL[interval]);
          const firstSeq = ret.sum[0][this._convertSeqColumnName(groupColumn)];
          if (startSeq < firstSeq) {
            returnData.push({
              [this._convertSeqColumnName(groupColumn)]: startSeq,
              sum: accuBurned
            });
          }
          for (let i = 0; i < ret.sum.length; i++) {
            accuBurned += (ret.sum[i].sum || 0);
            returnData.push({
              daySeq: ret.sum[i].daySeq,
              hourSeq: ret.sum[i].hourSeq,
              sum: accuBurned
            })
          }
          const lastSeq = returnData[returnData.length - 1][this._convertSeqColumnName(groupColumn)];
          const nowSeq = parseInt(toDate / Const.CHART_INTERVAL[interval]);
          if (nowSeq > lastSeq) {
            const nullData = {
              [this._convertSeqColumnName(groupColumn)]: nowSeq,
              sum: accuBurned
            };
            returnData.push(nullData);
          }

        } else {
          const startSeq = parseInt(fromDate / Const.CHART_INTERVAL[interval]);
          const nowSeq = parseInt(toDate / Const.CHART_INTERVAL[interval]);
          returnData.push({
            [this._convertSeqColumnName(groupColumn)]: startSeq,
            sum: accuBurned
          });
          returnData.push({
            [this._convertSeqColumnName(groupColumn)]: nowSeq,
            sum: accuBurned
          });
        }

        RedisCache.setAsync(key, JSON.stringify(returnData), CacheInfo.BurnedFees.TTL);
        return callback(null, returnData);
      });
    });
  },

  // Use for "Collected Fees" chart
  getCollectedFees: function (options, callback) {
    const KyberTradeModel = this.getModel('KyberTradeModel');
    const interval = options.interval || 'H1';
    const period = options.period || 'D7';

    let key = `${CacheInfo.CollectedFees.key + period}-${interval}`;
    if (options.address) {
      key = options.address + '-' + key;
    }

    if(options.official){
      key = 'official-' + key
    }

    RedisCache.getAsync(key, (err, ret) => {
      if (err) {
        logger.error(err)
      }
      if (ret) {
        return callback(null, JSON.parse(ret));
      }
      const groupColumn = this._getGroupColumnByIntervalParam(interval);
      const [fromDate, toDate] = this._getRequestDatePeriods(options, period, interval);

      let whereClauses = 'block_timestamp > ? AND block_timestamp <= ?';
      let params = [fromDate, toDate];

      if (options.address) {
        whereClauses += ' AND (taker_token_address = ? OR maker_token_address = ?)';
        params.push(options.address.toLowerCase());
        params.push(options.address.toLowerCase());
      }

      if(options.official){
        whereClauses += ` AND ( block_number < ? OR (source_official = 1 AND dest_official = 1))`;
        params.push(network.startPermissionlessReserveBlock);
      }

      async.auto({
        sum: (next) => {
          KyberTradeModel.sumGroupBy('collected_fees/1000000000000000000', {
            where: whereClauses,
            params: params,
            groupBy: [groupColumn],
          }, next);
        }
      }, (err, ret) => {
        if (err) {
          return callback(err);
        }

        const returnData = [];
        if (ret.sum.length) {

          for (let i = 0; i < ret.sum.length; i++) {
            returnData.push({
              daySeq: ret.sum[i].daySeq,
              hourSeq: ret.sum[i].hourSeq,
              sum: ret.sum[i].sum
            })
          }
          const lastSeq = returnData[returnData.length - 1][this._convertSeqColumnName(groupColumn)];
          const nowSeq = parseInt(toDate / Const.CHART_INTERVAL[interval]);
          if (nowSeq > lastSeq) {
            const nullData = {
              [this._convertSeqColumnName(groupColumn)]: nowSeq,
              sum: 0
            };
            returnData.push(nullData);
          }

        } else {
          const firstSeq = parseInt(fromDate / Const.CHART_INTERVAL[interval]);
          const nowSeq = parseInt(toDate / Const.CHART_INTERVAL[interval]);
          returnData.push({
            [this._convertSeqColumnName(groupColumn)]: firstSeq,
            sum: 0
          });
          returnData.push({
            [this._convertSeqColumnName(groupColumn)]: nowSeq,
            sum: 0
          });
        }

        RedisCache.setAsync(key, JSON.stringify(returnData), CacheInfo.CollectedFees.TTL);
        return callback(null, returnData);
      });
    });
  },

  // Use for "Fees To Burn" chart (not used)
  getToBurnFees: function (options, callback) {
    const KyberTradeModel = this.getModel('KyberTradeModel');
    const interval = options.interval || 'H1';
    const period = options.period || 'D7';

    let key = `${CacheInfo.ToBurnFees.key + period}-${interval}`;
    if (options.address) {
      key = options.address + '-' + key;
    }

    if(options.official){
      key = 'official-' + key
    }

    RedisCache.getAsync(key, (err, ret) => {
      if (err) {
        logger.error(err)
      }
      if (ret) {
        return callback(null, JSON.parse(ret));
      }
      const groupColumn = this._getGroupColumnByIntervalParam(interval);
      const [fromDate, toDate] = this._getRequestDatePeriods(options, period, interval);

      let whereClauses = 'block_timestamp > ? AND block_timestamp <= ?';
      let params = [fromDate, toDate];

      if (options.address) {
        whereClauses += ' AND (taker_token_address = ? OR maker_token_address = ?)';
        params.push(options.address.toLowerCase());
        params.push(options.address.toLowerCase());
      }

      if(options.official){
        whereClauses += ` AND ( block_number < ? OR (source_official = 1 AND dest_official = 1))`;
        params.push(network.startPermissionlessReserveBlock);
      }

      async.auto({
        sum: (next) => {
          KyberTradeModel.sumGroupBy('burn_fees/1000000000000000000', {
            where: whereClauses,
            params: params,
            groupBy: [groupColumn],
          }, next);
        },
        count: (next) => {
          KyberTradeModel.countGroupBy(groupColumn, {
            where: whereClauses,
            params: params,
            groupBy: [groupColumn]
          }, next);
        }
      }, (err, ret) => {
        if (err) {
          return callback(err);
        }

        const returnData = [];
        if (ret.sum.length) {

          for (let i = 0; i < ret.sum.length; i++) {
            returnData.push({
              daySeq: ret.sum[i].daySeq,
              hourSeq: ret.sum[i].hourSeq,
              sum: ret.sum[i].sum,
              count: ret.count[i].count
            })
          }
          const lastSeq = returnData[returnData.length - 1][this._convertSeqColumnName(groupColumn)];
          const nowSeq = parseInt(toDate / Const.CHART_INTERVAL[interval]);
          if (nowSeq > lastSeq) {
            const nullData = {
              [this._convertSeqColumnName(groupColumn)]: nowSeq,
              sum: 0,
              count: 0
            };
            returnData.push(nullData);
          }

        } else {
          const firstSeq = parseInt(fromDate / Const.CHART_INTERVAL[interval]);
          const nowSeq = parseInt(toDate / Const.CHART_INTERVAL[interval]);
          returnData.push({
            [this._convertSeqColumnName(groupColumn)]: firstSeq,
            sum: 0,
            count: 0
          });
          returnData.push({
            [this._convertSeqColumnName(groupColumn)]: nowSeq,
            sum: 0,
            count: 0
          });
        }

        RedisCache.setAsync(key, JSON.stringify(returnData), CacheInfo.ToBurnFees.TTL);
        return callback(null, returnData);
      });
    });
  },

  _getGroupColumnByIntervalParam: function (interval) {
    switch (interval) {
      case 'H1':
        return 'hour_seq';
      case 'M1':
        return 'minute_seq';
      case 'D1':
        return 'day_seq';
    }
  },

  _getRequestDatePeriods: function (options, period, interval) {
    let toDate = options.toDate || Utils.nowInSeconds();
    let fromDate = options.fromDate;

    if (!fromDate) {
      fromDate = toDate - Const.CHART_PERIOD[period];
    }

    // check if from < contract deploy date
    const deployInSeconds = 1518203242;
    if (fromDate < deployInSeconds) {
      fromDate = deployInSeconds;
    }

    // it is neccessary to get from begining of interval
    fromDate -= fromDate % Const.CHART_INTERVAL[interval];

    return [fromDate, toDate];
  },

  _convertSeqColumnName: function (seq) {
    if (seq === 'day_seq') {
      return 'daySeq';
    }
    return 'hourSeq';
  },

  

});
