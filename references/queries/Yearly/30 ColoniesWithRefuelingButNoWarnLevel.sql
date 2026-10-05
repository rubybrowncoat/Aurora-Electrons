SELECT
	PopName
	,Spaceports	
	,RefuelSTNs	
	,WarningFuel
FROM
	vw_pop
WHERE
	Spaceports + RefuelSTNs >= 1
and
	WarningFuel = 0
order by
	PopName