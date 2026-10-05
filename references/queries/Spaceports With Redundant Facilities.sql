SELECT
	PopName
	,Spaceports	
	,RefuelSTNs	
	,OrdxferSTNs	
	,CargoSTNs
FROM
	vw_pop
WHERE
	Spaceports >= 1
and
	RefuelSTNs + OrdxferSTNs + CargoSTNs > 0
order by
	Spaceports	desc
	,RefuelSTNs		desc
	,OrdxferSTNs		desc
	,CargoSTNs	desc
	,PopName