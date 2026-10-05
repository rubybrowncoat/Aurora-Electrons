SELECT
	*
FROM
	DIM_ComponentType as ct
inner JOIN
(
	select distinct ComponentTypeID from FCT_ShipDesignComponents where NoMaintFailure = 1
) as x
on x.ComponentTypeID = ct.ComponentTypeID