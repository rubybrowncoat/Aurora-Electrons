SELECT
	_pop.PopName
	--,_pop.Population
	,_comp.Name as Component
	,_popcomp.Amount
	--,_popcomp.*
	--,_comp.*
	--,*
FROM
	FCT_Population as _pop
inner JOIN
	(select max(RaceID) as RaceID from FCT_Race where NPR = 0) as CurrentRace
on
	CurrentRace.RaceID = _pop.RaceID
inner JOIN
	FCT_PopComponent as _popcomp
on
	_popcomp.PopulationID = _pop.PopulationID
inner JOIN
	FCT_ShipDesignComponents as _comp
on
	_comp.SDComponentID = _popcomp.ComponentID
order by
	_pop.Population desc
	