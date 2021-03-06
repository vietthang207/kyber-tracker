const _ = require('lodash');

const methods = ['GET', 'POST', 'PUT', 'DELETE'];
const routeGroups = [
  { prefix: '',             routes: require('./routes/web') },
  { prefix: '/api',         routes: require('./routes/api') },
  { prefix: '/webhooks',         routes: require('./routes/hook') },
  { prefix: '/chart',         routes: require('./routes/chart') },
  { prefix: '*',         routes: require('./routes/notfound') }
  // { prefix: '*',             routes: require('./routes/web') },
];

const allRoutes = {};

_.forEach(methods, method => {
  allRoutes[method] = {};
  _.forEach(routeGroups, groupRoute => {
    const prefix = groupRoute.prefix;
    const routes = groupRoute.routes[method];
    if (_.isEmpty(routes)) return;
    for (route in routes) {
      const handler = routes[route];
      const finalRoute = prefix + route;
      allRoutes[method][finalRoute] = handler;
    }
  });
});

module.exports = allRoutes;
