var Bundestagswahl = Bundestagswahl || {};

Bundestagswahl.Tabulator = function(results, result_type) {
  var self = this;

  // the raw result objects from the interim tallies.
  self.results = results;

  self._filter_admin = function(level) {
    // find the distinct set of administrative regions
    var fres = _.filter(self.results, function(r) { return r.admin_level === level; }),
        regs = _.map(fres, function(r) {
          return {
            'id': r.admin_id,
            'label': r.admin_label,
            'parent_id': r.parent_id
          };
        });
    return _.uniq(regs, function(r) { return r.id; });
  };

  // get a list of all electoral districts
  self.districts = _.memoize(_.partial(self._filter_admin, 'district'));

  // get a list of all federal states
  self.states = _.memoize(_.partial(self._filter_admin, 'state'));

  self.regularSeatsCount = _.memoize(function() {
    // calculate the number of regular (i.e. non excess mandate) seats.
    return self.districts().length * 2;
  });

  self._admin_results = function(level, id) {
    // get all raw results for one particular administrative zone (state, district).
    return _.filter(self.results, function(r) {
      return r.admin_level === level && r.admin_id === id;
    });
  };

  self.parties = function() {
    // a list of all parties.
    return _.uniq(_.pluck(_.filter(results, function(r) { return r.is_party; }), 'group'));
  };

  self.directMandates = _.memoize(function() {
    // determine the party of the candidate that has won a direct mandate for
    // each district.
    var pairs = _.map(self.districts(), function(district) {
      // get all the relevant results for party candidates. 
      var results = _.filter(self._admin_results('district', district.id), function(r) {
        return r.is_party && r.vote_type == 'Erststimmen' && r.type == result_type;
      });
      var winner,
          bestResult = _.max(results, function(r) { return r.votes; });
      
      // if there is a primary vote candidate with the most votes:
      if (bestResult && bestResult.votes > 0) {
        winner = bestResult.group;
      }

      // TODO: maybe only call it if a certain percentage of voters have 
      // cast their ballot?
      return [district.id, winner];
    });
    return _.object(pairs);
  });

  self.directMandatesByParty = _.memoize(function() {
    // group direct mandates by party.
    return _.countBy(_.pairs(self.directMandates()), function(pair) {
      return pair[1];
    });
  });

  self.directMandatesByStateAndParty = _.memoize(function() {
    // group direct mandates by state, then grouped by party.
    var mandates = self.directMandates(),
        states = _.groupBy(self.districts(), function(d) { return d.parent_id; });
        seats = _.map(states, function(districts, state) {
          return [state, _.countBy(districts, function(d) { return mandates[d.id]; })];
        });
    return _.object(seats);
  });

  self.totalValidNationalSecondaryVotes = _.memoize(function() {
    // total number of valid secondary votes cast on the federal level
    var result = _.find(self._admin_results('federal', 99), function(r) {
        return r.vote_type == 'Zweitstimmen' && r.type == result_type && r.group == 'Gültige';
    });
    return result ? result.votes : 0;
  });

  self.totalNationalSecondaryVotesByParty = _.memoize(function() {
    // total number of secondary votes cast on the federal level for each party
    var results = _.filter(self._admin_results('federal', 99), function(r) {
        return r.vote_type == 'Zweitstimmen' && r.type == result_type && r.is_party;
    });
    return _.object(_.map(results, function(r) {
      return [r.group, r.votes];
    }));
  });

  self.secondaryResultsByState = _.memoize(function() {
    // per-party secondary votes, grouped by state.
    var counts = {};
    _.each(self.states(), function(state) {
      var results = _.filter(self._admin_results('state', state.id), function(r) {
        return r.vote_type == 'Zweitstimmen' && r.type == result_type && r.is_party;
      });
      counts[state.id] = _.object(_.map(results, function(r) {
        return [r.group, r.votes];
      }));
    });
    return counts;
  });

  self.factions = _.memoize(function() {
    // determine which parties have met the barring clause requirement.
    var parties = [];

    // check if any of the parties have three or more direct mandates
    _.each(self.directMandatesByParty(), function(count, party) {
      if (count >= 3) parties.push(party);
    });

    // check if any of the parties have 5% or more of the nation vote
    var total = self.totalValidNationalSecondaryVotes();
    _.each(self.totalNationalSecondaryVotesByParty(), function(votes, party) {
      if ((votes / total) >= 0.05) parties.push(party);
    });

    return _.uniq(parties);
  });

  self.nonFactionSeatsByState = _.memoize(function() {
    // calculate the number of seats per state which are allocated
    // directly to a party (or candidate) which doesn't meet the
    // barring clause.
    var fs = self.factions(),
        states = _.map(self.directMandatesByStateAndParty(), function(parties, state) {
          var count = _.reduce(_.pairs(parties), function(m, p) {
            return !_.contains(fs, p[0]) ? m + p[1] : m;
            }, 0);
          return [state, count];
        });
    return _.object(states);
  });

  self.nationalNonFactionSeats = function() {
    // calculate the total number of seats which are allocated directly to a
    // person which is part of no party or a party not meeting the barring 
    // clause.
    return _.reduce(_.values(self.nonFactionSeatsByState()),
      Bundestagswahl.reduce_sum, 0);
  };

  self.availableSeatsByState = _.memoize(function() {
    // calculate how many seats per state will go into saint lague distribution.
    var seats = _.map(self.nonFactionSeatsByState(), function(blocked, state) {
      return [state, Bundestagswahl.STATE_SEATS[state] - blocked];
    });
    return _.object(seats);
  });

  self.minimalSeatsByParty = _.memoize(function() {
    // in order to calculate the minimal number of seats which each faction is
    // to receive, all available seats per state are divvied up according to 
    // saint lague, then excess mandates are added and the resulting numbers are
    // added up on a nation level.
    var directMandates = self.directMandatesByStateAndParty(),
        stateSeats = self.availableSeatsByState(),
        fs = self.factions(),
        minimalSeats = {};

    var initalDistribution = _.map(self.secondaryResultsByState(), function(parties, state) {
      // count only parties meeting the barring condition:
      parties = _.object(_.filter(_.pairs(parties), function(p) { return _.contains(fs, p[0]); }));
      var seats = Bundestagswahl.saint_lague_iterative(parties, stateSeats[state], {});
      _.each(seats, function(s, p) {
        var mandates = directMandates[state][p]||0;
        // create excess mandates
        seats[p] = Math.max(s, mandates);
      });
      return seats;
    });

    // sum up party seats on a national level.
    _.each(initalDistribution, function(parties) {
      _.each(parties, function(seats, party) {
        minimalSeats[party] = minimalSeats[party] ? minimalSeats[party] + seats : seats;
      });
    });
    return minimalSeats;
  });

  self.make_divisor = function (votes, minimalSeats) {
    // based on http://www.wahlrecht.de/bundestag/index.htm ("Bundesdivisor").
    var divisors = _.map(votes, function(count, party) {
      return count / (minimalSeats[party]-0.5);
    });
    return _.min(divisors);
  };

  self.upperDistribution = _.memoize(function() {
    // determine the number of seats available to each party on a national level, 
    // prior to their distribution to the states.

    // WARNING: does not include direct mandates gained by candidates without a 
    // faction.
    console.log("Errechne Oberverteilung...");

    var seatsAvailable = self.regularSeatsCount() - self.nationalNonFactionSeats(),
        minimalSeats = self.minimalSeatsByParty(),
        fs = self.factions(),
        results = self.totalNationalSecondaryVotesByParty();

    // filter out non-faction secondary votes.
    results = _.object(_.filter(_.pairs(results), function(p) { return _.contains(fs, p[0]); }));

    // generate an appropriate divisor (i.e. voter per seat)
    var divisor = self.make_divisor(results, minimalSeats);
    var distribution = {};
    _.each(results, function(votes, party) {
      // TODO: handle 0.5 case.
      distribution[party] = Math.round(votes / divisor);
    });
    return distribution;
  });

  self.lowerDistribution = _.memoize(function() {
    // distribute the seats allocated to the parties in upperDistribution to
    // state lists and direct mandates.
    console.log("Errechne Unterverteilung...");

    var results = self.secondaryResultsByState(),
        partySeats = self.upperDistribution(),
        distribution = {},
        directMandates = self.directMandatesByStateAndParty();
    
    _.each(partySeats, function(seats, party) {
      var stateVotes = {};
      _.each(results, function(votes, state) { stateVotes[state] = votes[party]; });
      var mandates = {};
      _.each(directMandates, function(ms, state) { mandates[state] = ms[party]; });
      distribution[party] = Bundestagswahl.saint_lague_iterative(stateVotes, seats, mandates);
    });

    return distribution;
  });

  self.tabulate = function() {
    // generate an object to interpret the vote results.
    
    // TODO: include more stats on participation, primary votes.
    var parties = {},
        states = {},
        upper = self.upperDistribution(),
        lower = self.lowerDistribution(),
        fs = self.factions(),
        directMandatesByParty = self.directMandatesByParty(),
        directMandatesByStateAndParty = self.directMandatesByStateAndParty(),
        nationalSecondaryVotes = self.totalNationalSecondaryVotesByParty(),
        stateSecondaryVotes = self.secondaryResultsByState();

    _.each(self.parties(), function(party) {
      var is_faction = _.contains(fs, party),
          seats = is_faction ? upper[party] : (directMandatesByParty[party] || 0);
      parties[party] = {
        is_faction: is_faction,
        total_seats: seats,
        direct_mandates: directMandatesByParty[party] || 0,
        secondary_votes: nationalSecondaryVotes[party]
      };
    });

    _.each(self.states(), function(state) {
      var parties = {};
      _.each(self.parties(), function(party) {
        var dm = directMandatesByStateAndParty[state.id][party] || 0,
            seats = lower[party] ? lower[party][state.id] || dm : dm;
        parties[party] = {
          total_seats: seats,
          direct_mandates: dm,
          secondary_votes: stateSecondaryVotes[state.id][party] || 0
        };
      });
      states[state.id] = {
        label: state.label,
        parties: parties
      };
    });

    return {
      summary: {
        election: self.results.election_name,
        result: self.results.result_type,
        valid_votes: self.totalValidNationalSecondaryVotes(),
        regular_seats: self.regularSeatsCount()
      },
      parties: parties,
      states: states
    };
  };

};
